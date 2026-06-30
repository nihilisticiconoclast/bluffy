/**
 * Role definitions and the powers attached to them.
 *
 * A Role is what a seat *is*; an Alignment is which side it wins with. The Seer
 * learns Alignment, never Role — so the two are kept distinct on purpose.
 */

export type Role = "werewolf" | "seer" | "doctor" | "villager";

export type Alignment = "wolf" | "town";

/** The faction a role belongs to (drives the night channel + win check). */
export function alignmentOf(role: Role): Alignment {
  return role === "werewolf" ? "wolf" : "town";
}

/** Night powers, by role. Used to decide whom the engine asks at night. */
export const NIGHT_POWER: Record<Role, "kill" | "investigate" | "protect" | null> = {
  werewolf: "kill",
  seer: "investigate",
  doctor: "protect",
  villager: null,
};

export interface RoleConfig {
  /** total seats */
  players: number;
  /** how many of each role to deal; must sum to `players` */
  roles: Record<Role, number>;
}

/** The baseline 6-player table from DESIGN.md §2. */
export const DEFAULT_CONFIG: RoleConfig = {
  players: 6,
  roles: { werewolf: 2, seer: 1, doctor: 1, villager: 2 },
};

/** Expand a config into a flat, deterministic list of roles (pre-shuffle). */
export function rolePool(config: RoleConfig): Role[] {
  const pool: Role[] = [];
  for (const role of ["werewolf", "seer", "doctor", "villager"] as Role[]) {
    for (let i = 0; i < (config.roles[role] ?? 0); i++) pool.push(role);
  }
  return pool;
}

/** Validate that a config is internally consistent. Throws on a bad config. */
export function assertValidConfig(config: RoleConfig): void {
  const sum = rolePool(config).length;
  if (sum !== config.players) {
    throw new Error(
      `config invalid: roles sum to ${sum} but players is ${config.players}`,
    );
  }
  if ((config.roles.werewolf ?? 0) < 1) {
    throw new Error("config invalid: need at least one werewolf");
  }
  if (config.roles.werewolf >= config.players - config.roles.werewolf) {
    throw new Error("config invalid: wolves already win at game start");
  }
}
