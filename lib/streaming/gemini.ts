import { Sandbox } from "@e2b/desktop";
import { GoogleGenerativeAI, GenerativeModel, Content, Part, FunctionDeclaration, Tool as GeminiTool } from "@google/generative-ai";
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

  private genAI: GoogleGenerativeAI;
  private model: GenerativeModel;

  constructor(desktop: Sandbox, resolutionScaler: ResolutionScaler) {
    this.desktop = desktop;
    this.resolutionScaler = resolutionScaler;
    this.instructions = INSTRUCTIONS;

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY is not set in environment variables.");
    }
    this.genAI = new GoogleGenerativeAI(apiKey);

    // TODO: Confirm the best model that supports function calling and vision if needed.
    // For now, using a model known for function calling. Vision model might be gemini-pro-vision or a newer one.
    // If the model needs to be different for vision, we might need a strategy to switch or use a multimodal model.
    // Let's start with a recent model that should support function calling.
    // The SDK docs used "gemini-2.0-flash-001" for function calling.
    // The current OpenAI implementation sends images, so a vision-capable model that also does function calling is ideal.
    // "gemini-1.5-flash-latest" or "gemini-1.5-pro-latest" are good candidates. Let's try flash for now.
    this.model = this.genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });
  }

  async executeAction(actionInfo: { name: string, args: any }): Promise<ActionResponse | object | void> {
    const { name, args } = actionInfo;
    logDebug(`Executing action: ${name}`, args);

    const desktop = this.desktop;

    try {
      switch (name) {
        case "screenshot": {
          // The screenshot itself is taken after the action completion in the stream method.
          // This tool call is more of an explicit request from the model to "observe".
          // No direct action on the desktop here, but we need to acknowledge.
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
          // OpenAI streamer had scroll_y, Gemini tool has direction and pixels.
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

  // Implemented stream method
  async *stream(
    props: ComputerInteractionStreamerFacadeStreamProps
  ): AsyncGenerator<SSEEvent<"gemini">> {
    logWarning("GeminiComputerStreamer.stream is not yet implemented.", props);
    // This will contain the main logic for interacting with the Gemini API,
    // handling streaming, function calls, and image sending.

    const { messages, signal } = props;

    // Define tools for Gemini based on OpenAIComputerStreamer actions
    const tools: GeminiTool[] = [{
      functionDeclarations: [
        {
          name: "screenshot",
          description: "Takes a screenshot of the current desktop state. Returns nothing.",
          parameters: { type: "OBJECT", properties: {} }, // No parameters for screenshot itself
        },
        {
          name: "double_click",
          description: "Performs a double click at the specified coordinates.",
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
          description: "Performs a click at the specified coordinates.",
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
          description: "Types the given text.",
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
              keys: { type: "STRING", description: "The key(s) to press." },
            },
            required: ["keys"],
          },
        },
        {
          name: "move",
          description: "Moves the mouse cursor to the specified coordinates.",
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
          description: "Scrolls the mouse wheel up or down.",
          parameters: {
            type: "OBJECT",
            properties: {
              direction: { type: "STRING", description: "'up' or 'down'.", enum: ["up", "down"] },
              pixels: { type: "NUMBER", description: "The amount to scroll in pixels." },
            },
            required: ["direction", "pixels"],
          },
        },
        // "wait" action might not be directly needed as a tool call, but rather an implicit part of model thinking or explicit instruction.
        // For now, let's omit it as a direct tool unless Gemini struggles without it.
        // {
        //   name: "wait",
        //   description: "Waits for a specified duration or for a condition to be met.",
        //   parameters: { type: "OBJECT", properties: { duration_ms: {type: "NUMBER", description: "Duration to wait in milliseconds."}} },
        // },
        {
          name: "drag",
          description: "Drags the mouse from a start coordinate to an end coordinate.",
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
      ],
    }];

    // System instruction part
    const systemInstructionPart: Content = {
        role: "system", // Though Gemini uses 'user' and 'model' roles, system instructions are often prepended or handled specially.
                        // For generateContent, system instructions can be part of the initial message or set on the model.
                        // The Gemini SDK's `generateContent` `systemInstruction` field is the preferred way.
                        // However, the `GenerativeModel` class does not seem to have a `systemInstruction` field directly for `getGenerativeModel`.
                        // Let's try setting it on the model instance if possible, or prepend to user messages.
                        // For now, I'll add it as a "user" role message at the beginning of the history,
                        // or use the `systemInstruction` field in `generateContent` if available with this SDK version/model.
                        // The `this.instructions` will be used.
        parts: [{text: this.instructions}]
    };

    // Prepare chat history for Gemini
    // Gemini expects roles 'user' and 'model'. Assistant messages from OpenAI need to be mapped to 'model'.
    // Images are also handled differently.
    let history: Content[] = [
        // systemInstructionPart, // Add system instructions at the beginning.
        // The current OpenAI implementation has instructions as a parameter to `openai.responses.create`
        // For Gemini, it seems `systemInstruction` can be passed to `generateContent`.
    ];

    // Convert existing messages to Gemini's format
    // The existing `messages` are of type `{ role: "user" | "assistant"; content: string }[]`
    // The `content` can also contain image URLs from the user or assistant (screenshots).
    // Example: { role: 'user', content: [ { type: 'text', text: 'hello' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,...' } } ] }
    // Gemini `Content` is { role: string, parts: Part[] }. `Part` can be { text: string } or { inlineData: { mimeType: string, data: string } }.

    for (const message of messages) {
        const role = message.role === "assistant" ? "model" : "user";
        let parts: Part[] = [];

        if (Array.isArray(message.content)) { // Check if content is an array of parts (OpenAI format)
            for (const contentPart of message.content) {
                if (contentPart.type === "text") {
                    parts.push({ text: contentPart.text });
                } else if (contentPart.type === "image_url" && contentPart.image_url) {
                    const base64Data = contentPart.image_url.url.split(',')[1];
                    if (base64Data) {
                        parts.push({
                            inlineData: {
                                mimeType: "image/png", // Assuming PNG, adjust if other types are used
                                data: base64Data,
                            },
                        });
                    }
                }
            }
        } else if (typeof message.content === 'string') { // Simple text message
            parts.push({ text: message.content });
        }

        if (parts.length > 0) {
            history.push({ role, parts });
        }
    }

    // Add the latest user message if it's not already in history (it should be)
    // The `messages` prop should contain the full history including the latest one.

    try {
      const modelRequest = {
        contents: history,
        tools: tools,
        systemInstruction: systemInstructionPart, // Using the dedicated field
      };
      logDebug("Gemini Model Request:", JSON.stringify(modelRequest, null, 2));

      const result = await this.model.generateContentStream(modelRequest);

      let accumulatedText = ""; // Accumulate text parts before yielding REASONING

      for await (const chunk of result.stream) {
        if (signal.aborted) {
          logDebug("Gemini stream aborted by user signal.");
          yield { type: SSEEventType.DONE, content: "Generation stopped by user" };
          return;
        }

        logDebug("Gemini chunk received:", JSON.stringify(chunk, null, 2));
        const chunkText = chunk.text?.(); // text() is a helper, might not exist or be empty

        if (chunkText) {
            accumulatedText += chunkText;
        }

        const functionCalls = chunk.functionCalls?.();
        if (functionCalls && functionCalls.length > 0) {
          // If there was any accumulated text before this function call, yield it.
          if (accumulatedText.trim()) {
            logDebug("Yielding REASONING (before function call):", accumulatedText);
            yield { type: SSEEventType.REASONING, content: accumulatedText };
            accumulatedText = ""; // Reset accumulated text
          }

          for (const fc of functionCalls) {
            logDebug("Yielding ACTION:", fc);
            yield { type: SSEEventType.ACTION, action: { type: fc.name, ...fc.args } as any }; // Map to existing Action type

            // Execute the action
            // The current design of executeAction is synchronous for OpenAI, but it might involve async desktop operations.
            // Let's assume executeAction can be async here.
            await this.executeAction(fc); // fc.name, fc.args

            yield { type: SSEEventType.ACTION_COMPLETED };

            // Take a new screenshot
            const newScreenshotData = await this.resolutionScaler.takeScreenshot();
            const newScreenshotBase64 = Buffer.from(newScreenshotData).toString("base64");

            // Prepare the function response part for Gemini
            const functionResponsePart: Part = {
              functionResponse: {
                name: fc.name,
                response: {
                  // The response to the function call should be what the model needs.
                  // Typically, this is the observation after the action, which is the new screenshot.
                  // We might also include a brief status message if applicable.
                  // Let's send back the screenshot as inline data.
                  // The content of the response depends on what the model expects for that function.
                  // For now, let's assume the screenshot is the primary output.
                  // The Gemini docs say "The response from the tool. Must be a JSON object."
                  // So, we should structure the screenshot within a JSON object.
                  name: fc.name, // It's good practice to include the function name in the response content
                  output: {
                    image_url: `data:image/png;base64,${newScreenshotBase64}`, // Mimicking OpenAI's previous format for now
                    // Or directly with inlineData if the model is trained for it:
                    // screenshot: { inlineData: { mimeType: "image/png", data: newScreenshotBase64 } }
                    // Let's try a simple structure that can be stringified.
                    status: "Action executed, new screenshot provided.",
                    // It's crucial that this part is what the model expects to see as the result of the function call.
                    // The current OpenAI implementation sends back an image_url.
                    // Let's try to send the image in a way Gemini can understand it as part of the function response.
                    // The `functionResponse` part itself should contain the result.
                    // The content here should be a JSON object that the model will parse.
                    // The actual screenshot data will be added to the history as a new 'user' (tool) message part.
                  }
                }
              }
            };

            // Add to history for the next turn: the function call from the model, and the function response from the tool.
            // The original functionCall from the model response should be added to history.
            // The stream provides `chunk.functionCalls()`. A `Content` object needs `role` and `parts`.
            // Model's turn that included the function call:
            // history.push({role: "model", parts: [{functionCall: fc}] }); // This is how you'd add the model's call to history.
            // Tool's (our) turn providing the response:
            // history.push({role: "user", parts: [functionResponsePart]}); // "user" role for tool responses is common.
                                                                        // Or "function" or "tool" if supported by the SDK/API.
                                                                        // The Gemini docs for Node.js show adding a `Part` with `functionResponse`
                                                                        // to the *next* `generateContent` call's `contents` array.

            // The screenshot itself needs to be part of the next request's `contents`.
            // The flow is:
            // 1. Model requests function call.
            // 2. We execute it.
            // 3. We prepare a `functionResponse` Part.
            // 4. We take a new screenshot. This screenshot becomes part of the input for the *next* model call.
            // The `functionResponsePart` tells the model the outcome of the function.
            // The new screenshot is a general observation.

            // The `generateContentStream` API is iterative. We need to send the function response back in the *next* call.
            // This means the current loop should break and we should re-call `generateContentStream` with updated history including the function response.
            // This matches the OpenAI `responses.create` iterative pattern.

            // For a streaming chat, the history is implicitly managed by the SDK's chat session (`model.startChat`).
            // Since we are using `generateContentStream` directly, we manage history.
            // After a function call, we need to send its result back.

            // Let's update history:
            // 1. The model's turn that contained the function call.
            //    The `chunk` itself, if it's a full response part, or construct it.
            //    A `Content` object with `role: 'model'` and `parts: chunk.parts` (which would include the functionCall).
            if (chunk.parts) {
                 history.push({ role: 'model', parts: chunk.parts });
            } else {
                // This case should ideally not happen if chunk.functionCalls() is populated.
                // We might need to manually construct this part if the SDK doesn't give it directly.
                logWarning("Chunk did not have 'parts' property, manually creating model part for function call history.")
                history.push({role: 'model', parts: [{functionCall: fc}] });
            }

            // 2. The tool's response.
            const toolResponseContent: Content = {
                role: "tool", // Gemini uses "tool" role for function responses.
                parts: [functionResponsePart]
            };
            history.push(toolResponseContent);

            // Add the new screenshot as a user message part for the next iteration.
            // This is what OpenAIComputerStreamer does: the screenshot is an "input_image".
            // For Gemini, it would be a 'user' role message with an image part.
            const newScreenshotPart: Part = {
                inlineData: {
                    mimeType: "image/png",
                    data: newScreenshotBase64,
                },
            };
            history.push({ role: "user", parts: [newScreenshotPart] });


            // Now, we need to make a new call to `generateContentStream` with the updated history.
            // This requires restructuring the loop or using a chat session object.
            // For now, to match OpenAI's iterative approach with `responses.create`,
            // we'll recursively call or loop. A `while(true)` loop is better here.
            // The current `for await (const chunk of result.stream)` processes one full model response.
            // If that response has a function call, we process it, then we need to send the result back for another model response.

            // This part of the logic needs to be outside the `for await (const chunk of result.stream)` loop,
            // and instead, the loop should be around `generateContentStream`.

            // Let's pause here on the stream implementation and refine the overall loop structure.
            // The current structure is processing chunks of a single generateContentStream call.
            // It should be more like:
            // while (true) {
            //   make generateContentStream call with current history
            //   process its response stream
            //   if text, yield text
            //   if function call, execute, update history with func response and new screenshot
            //   if no function call (just text), then it's done for this turn.
            // }
            // This will be implemented in the next iteration of this step.
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
    // Populate initial history from messages prop
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
        logDebug("Gemini Model Request:", JSON.stringify(modelRequest.contents, null, 2)); // Log only contents for brevity

        const result = await this.model.generateContentStream(modelRequest);

        let accumulatedText = "";
        let modelResponseParts: Part[] = [];
        let functionToCallInfo: { name: string; args: any; } | null = null;

        for await (const chunk of result.stream) {
          if (signal.aborted) {
            logDebug("Gemini stream aborted by user signal (during chunk processing).");
            // Potentially clean up or yield a specific abort message from here if needed
            return;
          }

          logDebug("Gemini chunk received:", JSON.stringify(chunk, null, 2));

          // Process text content
          const chunkText = chunk.text?.();
          if (chunkText) {
            accumulatedText += chunkText;
            // Yield REASONING incrementally for better UX
            yield { type: SSEEventType.REASONING, content: chunkText };
          }

          // Process function calls
          const functionCalls = chunk.functionCalls?.();
          if (functionCalls && functionCalls.length > 0) {
            // If there's any text part in this same chunk or preceding text parts for this turn,
            // ensure it's captured in modelResponseParts before the functionCall part.
            if (accumulatedText) { // Text accumulated from this or previous chunks in this turn
                modelResponseParts.push({ text: accumulatedText });
                accumulatedText = ""; // Reset for this turn as we are now processing a function call
            }
            // Assuming one function call per turn for now, as is common.
            const fc = functionCalls[0];
            functionToCallInfo = { name: fc.name, args: fc.args };
            modelResponseParts.push({ functionCall: fc }); // Add the raw function call to history
            break; // Stop processing chunks for this model turn, proceed to execute the function
          }
        }

        // After iterating through all chunks for the current model response:
        // If there's remaining accumulated text (model finished with text, no function call), add it to parts.
        if (accumulatedText) {
            modelResponseParts.push({ text: accumulatedText });
        }

        // Add the model's full response to history
        if (modelResponseParts.length > 0) {
          history.push({ role: "model", parts: modelResponseParts });
        }

        if (functionToCallInfo) {
          logDebug("Yielding ACTION:", functionToCallInfo);
          // Map Gemini's fc.args to the existing Action type structure used by executeAction and UI
          // The existing Action type is { type: string; ...other props specific to type }
          // Gemini's fc.args is already an object with parameters.
          yield { type: SSEEventType.ACTION, action: { type: functionToCallInfo.name, ...functionToCallInfo.args } as any };

          // Execute the action. `executeAction` needs to be adapted to handle Gemini's args format.
          // For now, assume executeAction is called with {name: string, args: object}
          const actionOutcome = await this.executeAction(functionToCallInfo);
          logDebug("Action outcome:", actionOutcome);

          yield { type: SSEEventType.ACTION_COMPLETED };

          const newScreenshotData = await this.resolutionScaler.takeScreenshot();
          const newScreenshotBase64 = Buffer.from(newScreenshotData).toString("base64");

          const functionResponsePayload: Part = {
            functionResponse: {
              name: functionToCallInfo.name,
              response: { // Must be a JSON object.
                status: "Action executed.", // Provide some minimal structured response.
                // Include actual structured output from actionOutcome if it exists
                ...(typeof actionOutcome === 'object' && actionOutcome !== null ? actionOutcome : {}),
              }
            }
          };
          history.push({ role: "tool", parts: [functionResponsePayload] });

          // Add the new screenshot as a user observation for the next model turn
          const newScreenshotObservationPart: Part = {
            inlineData: { mimeType: "image/png", data: newScreenshotBase64 }
          };
          // Important: The role for subsequent image inputs after a tool call should typically be 'user'
          // as it's an observation the user (or agent acting for user) provides.
          history.push({ role: "user", parts: [newScreenshotObservationPart]});

          functionToCallInfo = null; // Reset for the next iteration of the while loop
          // Continue loop to get next model response
        } else {
          // No function call in the model's last response, so interaction for this turn is complete.
          logDebug("Yielding DONE (no function call in final model response).");
          yield { type: SSEEventType.DONE };
          break; // Exit the while loop
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
