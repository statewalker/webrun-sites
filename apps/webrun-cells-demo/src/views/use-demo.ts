import { useSyncExternalStore } from "react";
import type { DemoModel, DemoSnapshot } from "../model/demo-model.js";

export const useDemo = (model: DemoModel): DemoSnapshot =>
  useSyncExternalStore(model.subscribe, model.getSnapshot);
