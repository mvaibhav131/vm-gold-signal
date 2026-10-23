import { NativeSelect } from '@mantine/core';
import { useState } from 'react';

import { useApi } from '../api/context';

/**
 * Preview only: lets the owner (and the e2e tests) put the simulated market into every state the
 * dashboard can show. It does not exist with the live API.
 */
export function PreviewPicker() {
  const api = useApi();
  const controls = api.scenarios;
  const [current, setCurrent] = useState(controls?.current() ?? '');
  if (!controls) return null;

  return (
    <NativeSelect
      label="Preview state (simulated data)"
      size="xs"
      value={current}
      data={controls.scenarios.map((s) => ({ value: s.id, label: s.label }))}
      onChange={(event) => {
        controls.set(event.currentTarget.value);
        setCurrent(event.currentTarget.value);
      }}
      data-testid="preview-scenario"
    />
  );
}
