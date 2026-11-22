/**
 * What a conversation is analysed for once it has ended: a summary, a
 * sentiment, a pass or fail against the owner's success criteria, and fields
 * to extract. The relay's own assistant sets it in assistant.config.json
 * (docs/conversations.md), a Max Cloud project in its settings; the analysis
 * itself is server/conversation-analysis.ts.
 */

export type AnalysisField = {
  name: string;
  type: "string" | "number" | "boolean" | "enum";
  /** Tells the model what to extract. */
  description: string;
  /** Required for enum: 2..20 distinct values. */
  options?: string[];
};

export type AnalysisConfig = {
  summary: boolean;
  sentiment: boolean;
  /** When set, the result carries `success`. */
  successCriteria?: string;
  fields: AnalysisField[];
};

export type AnalysisResult = {
  summary?: string;
  sentiment?: "positive" | "neutral" | "negative";
  success?: boolean;
  successReason?: string;
  /** One entry per configured field; null when the conversation does not say. */
  data?: Record<string, string | number | boolean | null>;
};

/** The limits of an analysis configuration, for the forms that edit one. */
export const ANALYSIS_LIMITS = { fields: 24, description: 400, criteria: 1000, options: 20, option: 80 } as const;

const FIELD_NAME = /^[a-zA-Z_][a-zA-Z0-9_]{0,47}$/;
export const ANALYSIS_FIELD_TYPES = ["string", "number", "boolean", "enum"] as const;
const FIELD_TYPES = ANALYSIS_FIELD_TYPES;
const MAX_FIELDS = ANALYSIS_LIMITS.fields;
const MAX_DESCRIPTION = ANALYSIS_LIMITS.description;
const MAX_CRITERIA = ANALYSIS_LIMITS.criteria;
const MAX_OPTIONS = ANALYSIS_LIMITS.options;
const MAX_OPTION = ANALYSIS_LIMITS.option;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function fieldFrom(raw: unknown, index: number): { field?: AnalysisField; problem?: string } {
  const label = `analysis.fields[${index}]`;
  if (!isRecord(raw)) return { problem: `${label} must be an object` };
  const { name, type, description, options } = raw;
  // `__proto__` is no key of an object: a field of that name would vanish from every result.
  if (typeof name !== "string" || !FIELD_NAME.test(name) || name === "__proto__")
    return {
      problem: `${label}.name must be letters, digits and underscores, not starting with a digit, at most 48 characters`
    };
  if (typeof type !== "string" || !FIELD_TYPES.includes(type as (typeof FIELD_TYPES)[number]))
    return { problem: `analysis field ${name}: type must be string, number, boolean or enum` };
  if (typeof description !== "string" || !description.trim())
    return { problem: `analysis field ${name}: needs a description that says what to extract` };
  if (description.trim().length > MAX_DESCRIPTION)
    return { problem: `analysis field ${name}: description is longer than ${MAX_DESCRIPTION} characters` };
  const field: AnalysisField = {
    name,
    type: type as AnalysisField["type"],
    description: description.trim()
  };
  if (type === "enum") {
    if (!Array.isArray(options) || options.some((option) => typeof option !== "string" || !option.trim()))
      return { problem: `analysis field ${name}: enum needs options, a list of 2 to ${MAX_OPTIONS} strings` };
    const list = options.map((option: string) => option.trim());
    if (list.length < 2 || list.length > MAX_OPTIONS)
      return { problem: `analysis field ${name}: enum needs 2 to ${MAX_OPTIONS} options` };
    if (list.some((option) => option.length > MAX_OPTION))
      return { problem: `analysis field ${name}: an option is longer than ${MAX_OPTION} characters` };
    if (new Set(list).size !== list.length) return { problem: `analysis field ${name}: options must be distinct` };
    field.options = list;
  } else if (options !== undefined) {
    return { problem: `analysis field ${name}: options are only for enum fields` };
  }
  return { field };
}

/** Parses the `analysis` key of assistant.config.json. `true` means { summary: true }. Absent/false → {}. */
export function analysisConfigFrom(raw: unknown): { config?: AnalysisConfig; problem?: string } {
  if (raw === undefined || raw === null || raw === false) return {};
  if (raw === true) return { config: { summary: true, sentiment: false, fields: [] } };
  if (!isRecord(raw)) return { problem: "analysis must be true or an object" };
  for (const key of ["summary", "sentiment"] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== "boolean")
      return { problem: `analysis.${key} must be true or false` };
  }
  let successCriteria: string | undefined;
  if (raw.successCriteria !== undefined) {
    if (typeof raw.successCriteria !== "string") return { problem: "analysis.successCriteria must be a string" };
    successCriteria = raw.successCriteria.trim() || undefined;
    if (successCriteria && successCriteria.length > MAX_CRITERIA)
      return { problem: `analysis.successCriteria is longer than ${MAX_CRITERIA} characters` };
  }
  const fields: AnalysisField[] = [];
  if (raw.fields !== undefined) {
    if (!Array.isArray(raw.fields)) return { problem: "analysis.fields must be a list" };
    if (raw.fields.length > MAX_FIELDS) return { problem: `analysis.fields has more than ${MAX_FIELDS} entries` };
    for (const [index, item] of raw.fields.entries()) {
      const { field, problem } = fieldFrom(item, index);
      if (!field) return { problem };
      if (fields.some((other) => other.name === field.name))
        return { problem: `analysis.fields: ${field.name} is listed twice` };
      fields.push(field);
    }
  }
  return {
    config: {
      summary: raw.summary !== false,
      sentiment: raw.sentiment === true,
      ...(successCriteria ? { successCriteria } : {}),
      fields
    }
  };
}
