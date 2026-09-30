// Adapter guarantees, not claims about every model hosted by a provider.
const a2aSourceCapabilities = {
  cursor: { serverTools: false, structuredOutput: false },
  qoder: { serverTools: false, structuredOutput: false },
  workbuddy: { serverTools: false, structuredOutput: false },
} as const;
export function a2aCapabilities(model: string) {
  const source = model.split("/")[0];
  return Object.hasOwn(a2aSourceCapabilities, source)
    ? a2aSourceCapabilities[source as keyof typeof a2aSourceCapabilities]
    : undefined;
}
