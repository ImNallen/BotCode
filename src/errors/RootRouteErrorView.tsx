// Ported from T3 Code v0.0.45 apps/web/src/routes/__root.tsx (MIT).
import {
  useLocation,
  useRouter,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import { ErrorView } from "./ErrorView";

export function RootRouteErrorView({ error }: ErrorComponentProps) {
  const router = useRouter();
  const pathname = useLocation({ select: (location) => location.pathname });
  return (
    <ErrorView
      error={error}
      area="Router"
      pathname={pathname}
      onRetry={() => router.invalidate()}
    />
  );
}
