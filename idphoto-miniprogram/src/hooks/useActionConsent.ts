import { useEffect, useRef, useState } from 'react';
import { createConsentSession } from '../core/consentSession';

export function useActionConsent(tool: string, invalidate: () => void) {
  const ref = useRef<any>(null);
  if (!ref.current) ref.current = createConsentSession(tool);
  const authorization = ref.current;
  const [granted, render] = useState<string[]>([]);
  const setGranted = (next: string[] | ((previous: string[]) => string[])) => {
    const value = typeof next === 'function' ? next(authorization.getGranted()) : next;
    if (!authorization.update(value)) return;
    invalidate(); render(authorization.getGranted());
  };
  useEffect(() => () => authorization.dispose(), [authorization]);
  return { granted, setGranted, authorization };
}
