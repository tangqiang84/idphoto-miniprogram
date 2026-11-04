import { useEffect, useRef, useState } from 'react';
import { createProcessingSession } from '../core/processingSession';
import { createT1Workflow } from '../core/t1Workflow';
import { createT1Processing } from '../services/t1Processing';
import { createConsentSession } from '../core/consentSession';

export function useT1Workflow(tool = 'T1') {
  const ref = useRef<any>(null);
  if (!ref.current) {
    const session = createProcessingSession({ tool });
    const authorization = createConsentSession(tool);
    const unsubscribeConsent = session.subscribe((value) => authorization.update(value.params.consents));
    ref.current = { session, authorization, unsubscribeConsent, flow: createT1Workflow(session, createT1Processing(tool), { tool }) };
  }
  const { session, flow, authorization, unsubscribeConsent } = ref.current;
  const [state, setState] = useState(flow.getState());
  useEffect(() => {
    const unsubscribe = flow.subscribe(setState);
    setState(flow.getState());
    return () => { unsubscribe(); unsubscribeConsent(); authorization.dispose(); flow.dispose(); session.dispose(); };
  }, [flow, session, authorization, unsubscribeConsent]);
  return { session, flow, state, authorization };
}
