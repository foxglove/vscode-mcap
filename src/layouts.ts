export interface Layout {
  id: string;
  name: string;
  data: Record<string, unknown>;
}
export function layoutData(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Layout must be a JSON object");
  return value as Record<string, unknown>;
}
export async function listLayouts(
  key: string,
  request: typeof fetch = fetch,
): Promise<Layout[]> {
  const response = await request(
    "https://api.foxglove.dev/v1/layouts?includeData=true",
    {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(20000),
      redirect: "error",
    },
  );
  if (!response.ok)
    throw new Error(
      `Foxglove layouts request failed (${response.status}). Check your API key and layout read permissions.`,
    );
  const body: unknown = await response.json();
  if (!Array.isArray(body))
    throw new Error("Invalid layout list returned by Foxglove");
  return body.map((item) => {
    if (
      !item ||
      typeof item !== "object" ||
      typeof item.id !== "string" ||
      typeof item.name !== "string" ||
      (item.folderName !== undefined && typeof item.folderName !== "string")
    )
      throw new Error("Invalid layout returned by Foxglove");
    return {
      id: `cloud:${item.id}`,
      name: item.folderName ? `${item.folderName}/${item.name}` : item.name,
      data: layoutData(item.data),
    };
  });
}
