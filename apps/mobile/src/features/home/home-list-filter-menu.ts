export interface HomeListFilterMenuProject {
  readonly key: string;
  readonly label: string;
}

type HomeListFilterMenuAction = {
  readonly type: "action";
  readonly title: string;
  readonly subtitle?: string;
  readonly state?: "on" | "off";
  readonly onPress: () => void;
};

type HomeListFilterMenuSubmenu = {
  readonly type: "submenu";
  readonly title: string;
  readonly items: HomeListFilterMenuAction[];
};

export interface HomeListFilterMenu {
  readonly title: string;
  readonly items: Array<HomeListFilterMenuAction | HomeListFilterMenuSubmenu>;
}

/**
 * Thread visibility is fleet-wide. The list can be narrowed by logical
 * project, but never by machine; machine selection belongs to task placement.
 */
export function buildHomeListFilterMenu(props: {
  readonly projects: ReadonlyArray<HomeListFilterMenuProject>;
  readonly selectedProjectKey: string | null;
  readonly onProjectChange: (projectKey: string | null) => void;
}): HomeListFilterMenu {
  const items: Array<HomeListFilterMenuAction | HomeListFilterMenuSubmenu> = [];

  if (props.projects.length > 0) {
    items.push({
      type: "submenu",
      title: "Project",
      items: [
        {
          type: "action",
          title: "All projects",
          subtitle: "Show threads from every project in the fleet",
          state: props.selectedProjectKey === null ? "on" : "off",
          onPress: () => props.onProjectChange(null),
        },
        ...props.projects.map((project) => ({
          type: "action" as const,
          title: project.label,
          state: props.selectedProjectKey === project.key ? ("on" as const) : ("off" as const),
          onPress: () => props.onProjectChange(project.key),
        })),
      ],
    });
  }

  return {
    title: "Project filter",
    items,
  };
}
