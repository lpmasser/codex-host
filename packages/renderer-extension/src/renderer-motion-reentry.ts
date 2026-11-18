import { loadCodexNativeServices } from "./codex-native-services.js";

interface ExitFeature {
  node: {
    presenceContext?: { isPresent: boolean };
    prevPresenceContext?: { isPresent: boolean };
    blockInitialAnimation: boolean;
  };
  isExitComplete: boolean;
  update(): void;
}

interface MotionFeatures {
  animation: { Feature: { prototype: { updateAnimationControlsSubscription(): void } } };
  exit: { Feature: { prototype: ExitFeature } };
}

// Native modules expose a zero-argument getter for their feature registry. Only
// invoke an exact "return binding" getter, never an arbitrary exported function.
const REGISTRY_GETTER = /^(?:function(?:\s+[\w$]+)?\(\)\{return [\w$]+\}|\(\)=>[\w$]+)$/;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

function isMotionRegistryGetter(value: unknown): value is () => MotionFeatures {
  if (typeof value !== "function") return false;
  let source: string;
  try {
    source = Function.prototype.toString.call(value);
  } catch {
    // Desktop also exports callable RPC stubs, which have no JavaScript source.
    return false;
  }
  if (!REGISTRY_GETTER.test(source)) return false;
  const features: unknown = value();
  if (!record(features) || !record(features.animation) || !record(features.exit)) return false;
  const animation = features.animation.Feature;
  const exit = features.exit.Feature;
  return (
    typeof animation === "function" &&
    record(animation.prototype) &&
    typeof animation.prototype.updateAnimationControlsSubscription === "function" &&
    typeof exit === "function" &&
    record(exit.prototype) &&
    typeof exit.prototype.update === "function" &&
    typeof exit.prototype.mount === "function"
  );
}

/** Motion's completed-exit path calls reset() then animateChanges(). reset marks
 * this as an initial animation again, so an AnimatePresence initial=false skips
 * reentry while remembering its target as already resolved. The exit values
 * then remain indefinitely. Reentry is not a first appearance: let the native
 * update animate it, retaining the initial policy for every other lifecycle.
 */
function installCompletedExitReentry(features: MotionFeatures): () => void {
  const prototype = features.exit.Feature.prototype;
  const original = prototype.update;
  const update = function (this: ExitFeature): void {
    const node = this.node;
    if (
      !this.isExitComplete ||
      node.presenceContext?.isPresent !== true ||
      node.prevPresenceContext?.isPresent !== false
    ) {
      return original.call(this);
    }
    const blocked = node.blockInitialAnimation;
    node.blockInitialAnimation = false;
    try {
      original.call(this);
    } finally {
      node.blockInitialAnimation = blocked;
    }
  };
  prototype.update = update;
  return () => {
    if (prototype.update === update) prototype.update = original;
  };
}

export function installRendererMotionReentry(ownerWindow: Window): {
  ready: Promise<void>;
  dispose(): void;
} {
  let disposed = false;
  let release: (() => void) | undefined;
  const ready = loadCodexNativeServices(ownerWindow, isMotionRegistryGetter).then(
    (readFeatures) => {
      if (disposed) return;
      if (!readFeatures) throw new Error("Native Motion feature registry is unavailable");
      release = installCompletedExitReentry(readFeatures());
    },
  );
  return {
    ready,
    dispose() {
      disposed = true;
      release?.();
    },
  };
}
