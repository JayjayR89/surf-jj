import ansis from "ansis";

export const logger = console;

const stringifyArg = (arg: unknown): string => {
  if (arg instanceof Error) {
    // For Error objects, include message and optionally stack or name
    // For server-side logs, stack might be too verbose, but for client-side debugging it's useful.
    // Let's keep it concise for general logging here.
    return `Error: ${arg.message}${arg.stack ? `\nStack: ${arg.stack}` : ''}`;
  }
  if (typeof arg === "object" && arg !== null) {
    try {
      return JSON.stringify(arg, null, 2);
    } catch (e) {
      return "[Unserializable Object]";
    }
  }
  return String(arg);
};

export const logError = (...args: Parameters<typeof console.error>) => {
  console.error(
    ansis.bgRedBright.white(" ERROR "),
    ansis.redBright(args.map(stringifyArg).join(" "))
  );
};

export const logDebug = (...args: Parameters<typeof console.debug>) => {
  console.debug(
    ansis.bgBlueBright.white(" DEBUG "),
    ansis.blueBright(args.map(stringifyArg).join(" "))
  );
};

export const logSuccess = (...args: Parameters<typeof console.log>) => {
  console.log(
    ansis.bgGreenBright.white(" SUCCESS "),
    ansis.greenBright(args.map(stringifyArg).join(" "))
  );
};

export const logWarning = (...args: Parameters<typeof console.warn>) => {
  console.warn(
    ansis.bgYellowBright.white(" WARNING "),
    ansis.yellowBright(args.map(stringifyArg).join(" "))
  );
};
