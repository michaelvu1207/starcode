import type { EnvironmentId } from "@starcode/contracts";

export interface VcsStatusTarget {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
}
