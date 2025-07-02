import { Sandbox } from "@e2b/desktop";
import { GoogleGenAI, GenerativeModel, Content, Part, FunctionDeclaration, Tool as GeminiTool } from "@google/genai"; // Corrected package name and main class
import { SSEEventType, SSEEvent, ActionResponse, ComputerModel } from "@/types/api";
import {
  ComputerInteractionStreamerFacade,
  ComputerInteractionStreamerFacadeStreamProps,
} from "@/lib/streaming";
import { logDebug, logError, logWarning } from "../logger";
import { ResolutionScaler } from "./resolution";

const INSTRUCTIONS = `
You are Surf, a helpful assistant designed to operate a virtual computer environment to assist users with their tasks.
You can use this virtual computer to browse the web, write and execute code, manage files, and interact with various applications.

This application provides you with a real-time view of a secure, isolated sandbox (a virtual computer) based on Ubuntu 22.04.
You will receive screenshots of this desktop, and you can issue commands to interact with it.
Because this is a secure sandbox, you can execute commands and operations as needed to fulfill user requests without concern for system security.

The sandbox environment includes common pre-installed applications:
- Firefox (web browser)
- Visual Studio Code (code editor)
- LibreOffice suite (office productivity)
- Python 3 (with common libraries)
- A standard Linux Terminal
- PCManFM (file manager)
- Gedit (text editor)
- Calculator and other basic utilities

Key Interaction Guidelines:

1.  **Tool Usage**: You have a set of tools (functions) to interact with the computer, such as 'click', 'type', 'keypress', 'scroll', 'drag', and 'screenshot'. Use these tools to perform actions based on the user's request and your reasoning.

2.  **Terminal Commands**:
    *   It is okay to run terminal commands as needed to complete tasks. Execute them efficiently.
    *   **CRITICAL**: When typing commands into the terminal, you MUST follow the typed command immediately with a 'keypress' action for the 'enter' key. Commands will not execute until Enter is pressed. For example, after typing 'ls -la', immediately call keypress('enter').

3.  **File Editing**: When asked to edit files, prefer using Visual Studio Code (VS Code) due to its advanced features like syntax highlighting and code completion, which can help avoid errors.

4.  **Observation**: After each action, you will receive a new screenshot. Use this visual feedback to understand the current state of the desktop and plan your next steps.

5.  **Clarity and Efficiency**: Aim to complete tasks accurately and efficiently. If a user's request is ambiguous, ask for clarification. Otherwise, proceed with the most logical sequence of actions.
`;

export class GeminiComputerStreamer implements ComputerInteractionStreamerFacade {
  public instructions: string;
  public desktop: Sandbox;
  public resolutionScaler: ResolutionScaler;

  private genAI: GoogleGenAI; // Corrected type
  private model: GenerativeModel;

  constructor(desktop: Sandbox, resolutionScaler: ResolutionScaler) {
    this.desktop = desktop;
    this.resolutionScaler = resolutionScaler;
    this.instructions = INSTRUCTIONS;

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY is not set in environment variables.");
    }
    this.genAI = new GoogleGenAI(apiKey); // Corrected instantiation
    this.model = this.genAI.getGenerativeModel({ model: "gemini-2.0-flash-exp" });
  }

  async executeAction(actionInfo: { name: string, args: any }): Promise<ActionResponse | object | void> {
    const { name, args } = actionInfo;
    logDebug(`Executing action: ${name}`, args);

    const desktop = this.desktop;

    try {
      switch (name) {
        case "screenshot": {
          return { status: "Screenshot will be provided." };
        }
        case "double_click": {
          const { x, y } = args;
          const coordinate = this.resolutionScaler.scaleToOriginalSpace([x, y]);
          await desktop.doubleClick(coordinate[0], coordinate[1]);
          return { status: `Double clicked at (${x}, ${y})` };
        }
        case "click": {
          const { x, y, button = "left" } = args;
          const coordinate = this.resolutionScaler.scaleToOriginalSpace([x, y]);
          if (button === "left") {
            await desktop.leftClick(coordinate[0], coordinate[1]);
          } else if (button === "right") {
            await desktop.rightClick(coordinate[0], coordinate[1]);
          } else if (button === "wheel") {
            await desktop.middleClick(coordinate[0], coordinate[1]);
          }
          return { status: `${button} clicked at (${x}, ${y})` };
        }
        case "type": {
          const { text } = args;
          await desktop.write(text);
          return { status: `Typed text: "${text}"` };
        }
        case "keypress": {
          const { keys } = args;
          await desktop.press(keys);
          return { status: `Pressed keys: "${keys}"` };
        }
        case "move": {
          const { x, y } = args;
          const coordinate = this.resolutionScaler.scaleToOriginalSpace([x, y]);
          await desktop.moveMouse(coordinate[0], coordinate[1]);
          return { status: `Moved mouse to (${x}, ${y})` };
        }
        case "scroll": {
          const { direction, pixels } = args;
          if (direction === "up") {
            await desktop.scroll("up", Math.abs(pixels));
          } else if (direction === "down") {
            await desktop.scroll("down", Math.abs(pixels));
          }
          return { status: `Scrolled ${direction} by ${pixels} pixels` };
        }
        case "drag": {
            const { startX, startY, endX, endY } = args;
            const startCoordinate = this.resolutionScaler.scaleToOriginalSpace([startX, startY]);
            const endCoordinate = this.resolutionScaler.scaleToOriginalSpace([endX, endY]);
            await desktop.drag(startCoordinate, endCoordinate);
            return { status: `Dragged mouse from (${startX}, ${startY}) to (${endX}, ${endY})` };
        }
        default: {
          logWarning("Unknown action type in GeminiComputerStreamer:", name, args);
          return { status: `Unknown action type: ${name}`, error: "Action not implemented" };
        }
      }
    } catch (error: any) {
        logError(`Error executing action ${name}:`, error);
        return { status: `Error executing action ${name}: ${error.message}`, error: true };
    }
  }

  async *stream(
    props: ComputerInteractionStreamerFacadeStreamProps
  ): AsyncGenerator<SSEEvent<"gemini">> {
    const { messages, signal } = props;

    const definedTools: FunctionDeclaration[] = [
        {
          name: "screenshot",
          description: "Takes a screenshot of the current desktop state. Returns nothing useful as direct output, observation is visual.",
          parameters: { type: "OBJECT", properties: {} },
        },
        {
          name: "double_click",
          description: "Performs a double click at the specified coordinates (x, y).",
          parameters: {
            type: "OBJECT",
            properties: {
              x: { type: "NUMBER", description: "The x-coordinate." },
              y: { type: "NUMBER", description: "The y-coordinate." },
            },
            required: ["x", "y"],
          },
        },
        {
          name: "click",
          description: "Performs a click at the specified coordinates (x, y) with a given mouse button.",
          parameters: {
            type: "OBJECT",
            properties: {
              x: { type: "NUMBER", description: "The x-coordinate." },
              y: { type: "NUMBER", description: "The y-coordinate." },
              button: { type: "STRING", description: "Mouse button: 'left', 'right', or 'wheel'. Defaults to 'left'.", enum: ["left", "right", "wheel"]},
            },
            required: ["x", "y"],
          },
        },
        {
          name: "type",
          description: "Types the given text into the active input field.",
          parameters: {
            type: "OBJECT",
            properties: {
              text: { type: "STRING", description: "The text to type." },
            },
            required: ["text"],
          },
        },
        {
          name: "keypress",
          description: "Presses the specified key or sequence of keys (e.g., 'enter', 'control+c').",
          parameters: {
            type: "OBJECT",
            properties: {
              keys: { type: "STRING", description: "The key(s) to press. For combinations, use '+' like 'control+c'." },
            },
            required: ["keys"],
          },
        },
        {
          name: "move",
          description: "Moves the mouse cursor to the specified coordinates (x, y).",
          parameters: {
            type: "OBJECT",
            properties: {
              x: { type: "NUMBER", description: "The x-coordinate." },
              y: { type: "NUMBER", description: "The y-coordinate." },
            },
            required: ["x", "y"],
          },
        },
        {
          name: "scroll",
          description: "Scrolls the mouse wheel 'up' or 'down' by a specified number of pixels.",
          parameters: {
            type: "OBJECT",
            properties: {
              direction: { type: "STRING", description: "'up' or 'down'.", enum: ["up", "down"] },
              pixels: { type: "NUMBER", description: "The amount to scroll." },
            },
            required: ["direction", "pixels"],
          },
        },
        {
          name: "drag",
          description: "Drags the mouse from a start coordinate (startX, startY) to an end coordinate (endX, endY).",
          parameters: {
            type: "OBJECT",
            properties: {
              startX: { type: "NUMBER", description: "The starting x-coordinate." },
              startY: { type: "NUMBER", description: "The starting y-coordinate." },
              endX: { type: "NUMBER", description: "The ending x-coordinate." },
              endY: { type: "NUMBER", description: "The ending y-coordinate." },
            },
            required: ["startX", "startY", "endX", "endY"],
          },
        },
    ];
    const geminiTools: GeminiTool[] = [{ functionDeclarations: definedTools }];

    const systemInstructionContent: Content = { role: "system", parts: [{ text: this.instructions }] };

    let history: Content[] = [];
    for (const message of messages) {
        const role = message.role === "assistant" ? "model" : "user";
        let parts: Part[] = [];
        if (Array.isArray(message.content)) {
            for (const contentPart of message.content) {
                if (contentPart.type === "text") {
                    parts.push({ text: contentPart.text });
                } else if (contentPart.type === "image_url" && contentPart.image_url) {
                    const base64Data = contentPart.image_url.url.split(',')[1];
                    if (base64Data) {
                        parts.push({ inlineData: { mimeType: "image/png", data: base64Data } });
                    }
                }
            }
        } else if (typeof message.content === 'string') {
            parts.push({ text: message.content });
        }
        if (parts.length > 0) {
            history.push({ role, parts });
        }
    }

    try {
      while (true) {
        if (signal.aborted) {
          logDebug("Gemini stream aborted by user signal (start of loop).");
          yield { type: SSEEventType.DONE, content: "Generation stopped by user" };
          return;
        }

        const modelRequest = {
          contents: history,
          tools: geminiTools,
          systemInstruction: systemInstructionContent,
        };
        logDebug("Gemini Model Request:", JSON.stringify(modelRequest.contents, null, 2));

        const result = await this.model.generateContentStream(modelRequest);

        let accumulatedText = "";
        let modelResponseParts: Part[] = [];
        let functionToCallInfo: { name: string; args: any; } | null = null;

        for await (const chunk of result.stream) {
          if (signal.aborted) {
            logDebug("Gemini stream aborted by user signal (during chunk processing).");
            return;
          }

          logDebug("Gemini chunk received:", JSON.stringify(chunk, null, 2));

          const chunkText = chunk.text?.();
          if (chunkText) {
            accumulatedText += chunkText;
            yield { type: SSEEventType.REASONING, content: chunkText };
          }

          const functionCalls = chunk.functionCalls?.();
          if (functionCalls && functionCalls.length > 0) {
            if (accumulatedText) {
                modelResponseParts.push({ text: accumulatedText });
                accumulatedText = "";
            }
            const fc = functionCalls[0];
            functionToCallInfo = { name: fc.name, args: fc.args };
            modelResponseParts.push({ functionCall: fc });
            break;
          }
        }

        if (accumulatedText) {
            modelResponseParts.push({ text: accumulatedText });
        }

        if (modelResponseParts.length > 0) {
          history.push({ role: "model", parts: modelResponseParts });
        }

        if (functionToCallInfo) {
          logDebug("Yielding ACTION:", functionToCallInfo);
          yield { type: SSEEventType.ACTION, action: { type: functionToCallInfo.name, ...functionToCallInfo.args } as any };

          const actionOutcome = await this.executeAction(functionToCallInfo);
          logDebug("Action outcome:", actionOutcome);

          yield { type: SSEEventType.ACTION_COMPLETED };

          const newScreenshotData = await this.resolutionScaler.takeScreenshot();
          const newScreenshotBase64 = Buffer.from(newScreenshotData).toString("base64");

          const functionResponsePayload: Part = {
            functionResponse: {
              name: functionToCallInfo.name,
              response: {
                status: "Action executed.",
                ...(typeof actionOutcome === 'object' && actionOutcome !== null ? actionOutcome : {}),
              }
            }
          };
          history.push({ role: "tool", parts: [functionResponsePayload] });

          const newScreenshotObservationPart: Part = {
            inlineData: { mimeType: "image/png", data: newScreenshotBase64 }
          };
          history.push({ role: "user", parts: [newScreenshotObservationPart]});

          functionToCallInfo = null;
        } else {
          logDebug("Yielding DONE (no function call in final model response).");
          yield { type: SSEEventType.DONE };
          break;
        }
      }
    } catch (error: any) {
      logError("GEMINI_STREAMER Error:", error);
      let errorMessage = "An error occurred with the AI service. Please try again.";
      if (error.response && error.response.promptFeedback) {
        errorMessage = `AI service rejected the request due to prompt feedback: ${JSON.stringify(error.response.promptFeedback)}`;
      } else if (error.message) {
        if (error.message.includes("API key not valid")) {
            errorMessage = "Invalid Gemini API Key. Please check your .env.local file and Google Cloud console.";
        } else if (error.message.toLowerCase().includes("quota")) {
            errorMessage = "Gemini API quota exceeded. Please check your Google Cloud project quotas.";
        } else if (error.message.includes("Request payload size exceeds the limit")) {
            errorMessage = "The request (including images) is too large for the Gemini API.";
        } else {
            errorMessage = error.message;
        }
      }
      yield { type: SSEEventType.ERROR, content: errorMessage };
      yield { type: SSEEventType.DONE };
    }
  }
}
