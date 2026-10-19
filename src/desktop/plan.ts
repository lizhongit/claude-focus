export const PLAN_IDS = [
  "free",
  "pro",
  "max",
  "max_5x",
  "max_20x",
  "team",
  "enterprise",
  "api",
  "api_team",
] as const;

export type PlanId = (typeof PLAN_IDS)[number];

const PLAN_LABELS: Record<PlanId, string> = {
  free: "Free",
  pro: "Pro",
  max: "Max",
  max_5x: "Max 5x",
  max_20x: "Max 20x",
  team: "Team",
  enterprise: "Enterprise",
  api: "API",
  api_team: "API Team",
};

export function isPlanId(value: string): value is PlanId {
  return (PLAN_IDS as readonly string[]).includes(value);
}

export function formatPlanLabel(plan: string | null): string {
  if (plan != null && isPlanId(plan)) return PLAN_LABELS[plan];
  return "—";
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function planFromOrganization(org: Record<string, unknown>): PlanId | null {
  const capabilities = stringList(org.capabilities);
  if (capabilities.length === 0) return null;
  const has = (name: string): boolean => capabilities.includes(name);
  if (has("api") && has("chat")) return null;
  if (has("api")) return has("api_individual") ? "api" : "api_team";
  if (!has("chat")) return null;
  if (has("raven")) {
    if (org.raven_type === "enterprise") return "enterprise";
    if (typeof org.raven_type === "string" && org.raven_type.length > 0) return "team";
    return null;
  }
  if (has("claude_max")) {
    if (org.rate_limit_tier === "default_claude_max_5x") return "max_5x";
    if (org.rate_limit_tier === "default_claude_max_20x") return "max_20x";
    return "max";
  }
  if (has("claude_pro")) return "pro";
  return "free";
}

export function planFromBootstrap(
  data: unknown,
  organizationUuid: string | null,
): PlanId | null {
  if (data == null || typeof data !== "object" || Array.isArray(data)) return null;
  const account = (data as Record<string, unknown>).account;
  if (account == null || typeof account !== "object" || Array.isArray(account)) {
    return null;
  }
  const memberships = (account as Record<string, unknown>).memberships;
  if (!Array.isArray(memberships)) return null;
  const organizations: Record<string, unknown>[] = [];
  for (const item of memberships) {
    if (item == null || typeof item !== "object" || Array.isArray(item)) continue;
    const organization = (item as Record<string, unknown>).organization;
    if (
      organization == null ||
      typeof organization !== "object" ||
      Array.isArray(organization)
    ) {
      continue;
    }
    organizations.push(organization as Record<string, unknown>);
  }
  if (organizationUuid != null) {
    const match = organizations.find((organization) => {
      const uuid = organization.uuid;
      return (
        typeof uuid === "string" && uuid.toLowerCase() === organizationUuid.toLowerCase()
      );
    });
    return match == null ? null : planFromOrganization(match);
  }
  if (organizations.length === 1) {
    const only = organizations[0];
    return only == null ? null : planFromOrganization(only);
  }
  return null;
}
