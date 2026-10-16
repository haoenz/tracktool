import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { TrackDetail } from "../shared/track-edit.js";

/** An edit must keep the version the user saw, even when another panel updates the cache. */
export function useEditSnapshot(
  id: string,
  read: (id: string) => Promise<TrackDetail>,
) {
  const query = useQuery({
    queryKey: ["track-detail", id],
    queryFn: () => read(id),
    enabled: !!id,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const [snapshot, setSnapshot] = useState<TrackDetail>();
  useEffect(() => {
    if (query.data && snapshot?.entry.entry_id !== id) setSnapshot(query.data);
  }, [query.data, id, snapshot?.entry.entry_id]);
  return {
    ...query,
    data: snapshot?.entry.entry_id === id ? snapshot : query.data,
    refetch: async () => {
      const result = await query.refetch();
      if (result.data) setSnapshot(result.data);
      return result;
    },
  };
}
