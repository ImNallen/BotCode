// Ported from T3 Code v0.0.45 apps/web/src/components/RenderErrorBoundary.tsx (MIT).
import { Component, type ReactNode } from "react";

type Recovery = { error: unknown; reset: () => void };

type RenderErrorBoundaryProps = {
  children: ReactNode;
  fallback: ReactNode | ((recovery: Recovery) => ReactNode);
  resetKeys?: readonly unknown[];
};

type RenderErrorBoundaryState = {
  resetKeys: readonly unknown[] | undefined;
} & ({ kind: "healthy" } | { kind: "failed"; error: unknown });

export class RenderErrorBoundary extends Component<
  RenderErrorBoundaryProps,
  RenderErrorBoundaryState
> {
  override state: RenderErrorBoundaryState = {
    kind: "healthy",
    resetKeys: this.props.resetKeys,
  };

  static getDerivedStateFromProps(
    { resetKeys }: RenderErrorBoundaryProps,
    state: RenderErrorBoundaryState,
  ): RenderErrorBoundaryState | null {
    if (
      resetKeys?.length !== state.resetKeys?.length ||
      resetKeys?.some((key, index) => !Object.is(key, state.resetKeys?.[index]))
    ) {
      return { kind: "healthy", resetKeys };
    }
    return null;
  }

  static getDerivedStateFromError(error: unknown): {
    kind: "failed";
    error: unknown;
  } {
    return { kind: "failed", error };
  }

  private reset = () => {
    this.setState({ kind: "healthy", resetKeys: this.props.resetKeys });
  };

  override render() {
    if (this.state.kind === "healthy") return this.props.children;
    return typeof this.props.fallback === "function"
      ? this.props.fallback({ error: this.state.error, reset: this.reset })
      : this.props.fallback;
  }
}
