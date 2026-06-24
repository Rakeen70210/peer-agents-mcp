export type RoutedProvider = "grok" | "antigravity";

export type RouteSpec = {
  routedProvider: RoutedProvider;
  cli: RoutedProvider;
  label: string;
  modelSource: "cli-default";
};

export const ROUTE_CATALOG: Record<RoutedProvider, RouteSpec> = {
  grok: {
    routedProvider: "grok",
    cli: "grok",
    label: "Grok (CLI default model)",
    modelSource: "cli-default",
  },
  antigravity: {
    routedProvider: "antigravity",
    cli: "antigravity",
    label: "Antigravity (CLI default model)",
    modelSource: "cli-default",
  },
};

export function resolveRouteSpec(route: RoutedProvider): RouteSpec {
  return ROUTE_CATALOG[route];
}