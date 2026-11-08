// Server reads the app keeps live: refetched on the server's realtime signal and when the realtime
// connection comes back (signals aren't replayed).
import { useCallback, useEffect, useRef, useState } from "react";
import {
  experimental_PluginRpcCallError,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { PluginRpcResult } from "@get-bb/plugin-sdk/app";
import type { RpcContract } from "../shared/rpc-contract.js";

export function errorText(cause: unknown): string {
  const error = experimental_PluginRpcCallError.from(cause);
  return error.issues?.length ? error.issues.map((issue) => issue.message).join(" ") : error.message;
}

/** Runs `callback` on every return to "connected" after the first. */
export function useOnReconnect(callback: () => void) {
  const connection = useRealtimeConnectionState();
  const wasConnected = useRef(connection === "connected");
  useEffect(() => {
    if (connection !== "connected") wasConnected.current = false;
    else if (!wasConnected.current) {
      wasConnected.current = true;
      callback();
    }
  }, [connection, callback]);
}

type LiveMethod = "health" | "bots";

/** A null-input read, live on `channel`. `show` displays another request's answer (a save racing a refetch). */
export function useLive<M extends LiveMethod>(method: M, channel: string) {
  type Value = PluginRpcResult<RpcContract[M]>;
  const rpc = useRpc<RpcContract>();
  const [value, setValue] = useState<Value | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Shows only the newest answer.
  const latest = useRef(0);
  const show = useCallback((request: Promise<Value>) => {
    const seq = ++latest.current;
    return request.then((next) => {
      if (seq !== latest.current) return;
      setValue(next);
      setError(null);
    });
  }, []);
  const refetch = useCallback(
    () => show(rpc.call(method, null) as Promise<Value>).catch((cause: unknown) => setError(errorText(cause))),
    [show, rpc, method],
  );
  useEffect(() => void refetch(), [refetch]);
  useRealtime(channel, refetch);
  useOnReconnect(refetch);
  return { value, error, show, refetch };
}
