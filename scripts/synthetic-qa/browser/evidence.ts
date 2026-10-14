/** A passing scenario is only reviewable after its evidence has been persisted. */
export async function persistEvidence(evidence: unknown, request: typeof fetch = fetch): Promise<void> {
  const response = await request("/qa-evidence", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(evidence)
  });
  if (!response.ok || (await response.text()) !== "saved")
    throw new Error(`Synthetic evidence was not saved (HTTP ${response.status})`);
}
