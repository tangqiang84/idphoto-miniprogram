import { useEffect, useRef, useState } from 'react';
import { createProcessingSession } from '../core/processingSession';

export function useProcessingSession(onInvalidate: (changed: string[]) => void) {
  const ref = useRef<ReturnType<typeof createProcessingSession> | null>(null);
  if (!ref.current) ref.current = createProcessingSession();
  const session = ref.current;
  const [snapshot, setSnapshot] = useState(session.getState());
  const invalidate = useRef(onInvalidate);
  invalidate.current = onInvalidate;
  useEffect(() => {
    let revision = session.getState().revision;
    const unsubscribe = session.subscribe((next) => {
      if (next.revision !== revision) { revision = next.revision; invalidate.current(next.changed); }
      setSnapshot(next);
    });
    return () => { unsubscribe(); session.dispose(); };
  }, [session]);
  return { session, snapshot };
}
