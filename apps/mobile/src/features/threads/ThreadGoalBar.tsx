import type { ThreadGoal } from "@starcode/contracts";
import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";

interface ThreadGoalBarProps {
  readonly goal: ThreadGoal | null | undefined;
  readonly supported: boolean;
  readonly disabled: boolean;
  readonly onSet: (objective: string) => Promise<boolean>;
  readonly onStatusChange: (status: "active" | "paused") => Promise<boolean>;
  readonly onClear: () => Promise<boolean>;
}

const STATUS_LABELS: Record<ThreadGoal["status"], string> = {
  active: "Active",
  paused: "Paused",
  blocked: "Blocked",
  usageLimited: "Usage limit",
  budgetLimited: "Budget limit",
  complete: "Complete",
};

export function ThreadGoalBar(props: ThreadGoalBarProps) {
  const [editing, setEditing] = useState(false);
  const [objective, setObjective] = useState(props.goal?.objective ?? "");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!editing) setObjective(props.goal?.objective ?? "");
  }, [editing, props.goal?.objective]);

  if (!props.supported && !props.goal) return null;

  const submit = async () => {
    const trimmed = objective.trim();
    if (!trimmed || trimmed.length > 4_000) return;
    setPending(true);
    const succeeded = await props.onSet(trimmed);
    setPending(false);
    if (succeeded) setEditing(false);
  };

  if (!props.goal && !editing) {
    return (
      <View className="items-end px-4 pb-2">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Set goal"
          disabled={props.disabled}
          className="rounded-full bg-neutral-100 px-3 py-2 dark:bg-neutral-900"
          onPress={() => setEditing(true)}
        >
          <Text className="font-starcode-bold text-xs text-sky-700 dark:text-sky-300">
            ◎ Set goal
          </Text>
        </Pressable>
      </View>
    );
  }

  if (!props.goal || editing) {
    return (
      <View className="mx-4 mb-2 flex-row items-center gap-2 rounded-2xl border border-neutral-200 bg-neutral-100/95 p-2 dark:border-white/6 dark:bg-neutral-900/95">
        <TextInput
          autoFocus
          value={objective}
          maxLength={4_000}
          placeholder="What should Codex keep working toward?"
          editable={!props.disabled && !pending}
          className="min-h-10 flex-1 border-0 bg-transparent py-1"
          onChangeText={setObjective}
          onSubmitEditing={() => void submit()}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Save goal"
          disabled={props.disabled || pending || objective.trim().length === 0}
          className="rounded-xl bg-sky-500 px-3 py-2"
          onPress={() => void submit()}
        >
          <Text className="font-starcode-bold text-xs text-white">Save</Text>
        </Pressable>
        {props.goal ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cancel editing goal"
            disabled={pending}
            className="rounded-xl px-2 py-2"
            onPress={() => setEditing(false)}
          >
            <Text className="font-starcode-bold text-xs text-neutral-500">Cancel</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }

  const goal = props.goal;
  const canPause = goal.status === "active";
  const canResume =
    goal.status === "paused" ||
    goal.status === "blocked" ||
    goal.status === "usageLimited" ||
    goal.status === "budgetLimited";

  return (
    <View className="mx-4 mb-2 flex-row items-center gap-2 rounded-2xl border border-neutral-200 bg-neutral-100/95 px-3 py-2.5 dark:border-white/6 dark:bg-neutral-900/95">
      <Text className="text-base text-sky-600 dark:text-sky-300">◎</Text>
      <Text className="flex-1 font-starcode-bold text-sm" numberOfLines={1}>
        {goal.objective}
      </Text>
      <Text className="text-2xs text-neutral-500">{STATUS_LABELS[goal.status]}</Text>
      {canPause || canResume ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={canPause ? "Pause goal" : "Resume goal"}
          disabled={props.disabled || pending}
          onPress={() => {
            setPending(true);
            void props
              .onStatusChange(canPause ? "paused" : "active")
              .finally(() => setPending(false));
          }}
        >
          <Text className="font-starcode-bold text-xs text-sky-700 dark:text-sky-300">
            {canPause ? "Pause" : "Resume"}
          </Text>
        </Pressable>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Edit goal"
        disabled={props.disabled || pending}
        onPress={() => setEditing(true)}
      >
        <Text className="text-xs text-neutral-500">Edit</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Clear goal"
        disabled={props.disabled || pending}
        onPress={() => {
          setPending(true);
          void props.onClear().finally(() => setPending(false));
        }}
      >
        <Text className="text-xs text-rose-600 dark:text-rose-300">Clear</Text>
      </Pressable>
    </View>
  );
}
