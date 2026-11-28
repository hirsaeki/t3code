import { describe, expect, it } from "vite-plus/test";
import { parseAntigravityQuotaReport } from "./antigravityQuotaReport";

const capturedShape = {
  status: "SUCCESS",
  num_turns: 0,
  command: {
    name: "usage",
    data: {
      groups: [
        {
          name: "Gemini Models",
          buckets: [
            {
              id: "gemini-5h",
              name: "Five Hour Limit Remaining",
              window: "5h",
              remaining_fraction: 0.73,
              reset_time: "2026-11-28T03:20:00Z",
            },
            { id: "gemini-weekly", window: "weekly", remaining_fraction: 1.2 },
          ],
        },
      ],
    },
  },
};

describe("parseAntigravityQuotaReport", () => {
  it("reads one pretty-printed report surrounded by shell text and keeps missing values unknown", () => {
    const text = JSON.stringify(
      { ...capturedShape, response: 'Contains "quotes" and { braces }' },
      null,
      2,
    );
    const selection = `PS> agy -p "/usage" --output-format json\r\n${text}\r\nPS>`;
    expect(parseAntigravityQuotaReport(selection)).toEqual([
      {
        name: "Gemini Models",
        windows: [
          {
            id: "gemini-5h",
            label: "Five Hour Limit Remaining",
            remaining: 0.73,
            resetsAt: "2026-11-28T03:20:00Z",
          },
          { id: "gemini-weekly", label: "weekly", remaining: null, resetsAt: null },
        ],
      },
    ]);
  });

  it("rejects truncated, ambiguous, error and model-turn output", () => {
    const valid = JSON.stringify(capturedShape);
    for (const text of [
      valid.slice(0, -1),
      `${valid}\n${valid}`,
      JSON.stringify({ ...capturedShape, status: "ERROR" }),
      JSON.stringify({ ...capturedShape, num_turns: 1 }),
      JSON.stringify({ num_turns: 1, usage: { total_tokens: 30 } }),
    ]) {
      expect(parseAntigravityQuotaReport(text)).toBeNull();
    }
  });
});
