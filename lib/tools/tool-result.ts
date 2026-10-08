type ToolTextContent = { type: "text"; text: string };
type ToolResult<TDetails extends object> = {
  content: ToolTextContent[];
  details: TDetails;
};

/**
 * Standardized tool result constructors.
 */
export function toolOk<TDetails extends object = Record<string, never>>(
  text: string,
  details = {} as TDetails,
): ToolResult<TDetails> {
  return {
    content: [{ type: "text", text }],
    details,
  };
}

export function toolError<TDetails extends object = Record<string, never>>(
  text: string,
  details = {} as TDetails,
): ToolResult<TDetails & { error: string }> {
  return {
    content: [{ type: "text", text: `ERROR: ${text}` }],
    details: { ...details, error: text },
  };
}
