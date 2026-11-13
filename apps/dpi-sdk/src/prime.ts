// Prime's own durable work for one session: the goal, the heartbeat and the schedules. Served by prime-backend only
// (GET /v1/sessions/:s/prime/work, and the `prime_work` session frame).

export type PrimeGoalStatus = "active" | "paused" | "budget_limited" | "complete" | "error";

/** Prime's GoalState (crates/pa-types/src/goal.rs); absent when the session has no goal. */
export type PrimeGoal = {
  status: PrimeGoalStatus;
  objective: string;
  /** Absent when the goal has no budget. */
  tokenBudget?: number;
  tokensUsed: number;
  timeUsedSeconds: number;
  continuationsUsed: number;
  /** Why it stopped, when it did. */
  reason?: string;
};

/** A live schedule or the heartbeat (Prime's AgentCronJob). `id` is Prime's job id, and changes when a schedule is edited. */
export type PrimeJob = {
  id: string;
  status: "active" | "paused";
  /** The schedule text as entered: "in 30m", "every 1h", "at <ISO date>" or a cron expression. */
  schedule: string;
  prompt: string;
  nextRunAt?: string;
  lastRunAt?: string;
  runCount: number;
  /** Heartbeats only: how a fire is delivered while the session is busy. */
  deliveryMode?: "steer" | "follow_up";
};

export type PrimeWork = {
  goal: PrimeGoal | null;
  heartbeat: PrimeJob | null;
  schedules: PrimeJob[];
};

export type PrimeGoalAction = "pause" | "resume" | "clear";
export type PrimeHeartbeatAction = "pause" | "resume" | "stop";

/** What a goal command answers: `queued` means the agent was busy, so the command waits behind the running turn. */
export type PrimeGoalResult = { queued: boolean };
