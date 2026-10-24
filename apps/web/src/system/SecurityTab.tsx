import {
  Alert,
  Button,
  Code,
  Group,
  List,
  PasswordInput,
  Stack,
  Table,
  Text,
  TextInput,
  VisuallyHidden,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SessionInfo, TotpSetupResponse } from '@vmgs/contracts';
import { useState } from 'react';

import { ApiError } from '../api/client';
import { useApi } from '../api/context';
import { ME_KEY } from '../auth/RequireAuth';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { QueryBoundary, ScrollBox, Section } from '../components/page';
import { TimeText } from '../components/TimeText';
import { ToneBadge } from '../components/ToneBadge';
import { KEYS, useSessions } from '../data/queries';
import {
  emptyPasswordForm,
  toPasswordRequest,
  validateCode,
  validatePasswordForm,
} from './security';

function PasswordSection() {
  const api = useApi();
  const queryClient = useQueryClient();
  const form = useForm({
    mode: 'uncontrolled',
    initialValues: emptyPasswordForm,
    validate: validatePasswordForm,
  });
  const change = useMutation({
    mutationFn: (values: typeof emptyPasswordForm) => api.changePassword(toPasswordRequest(values)),
    onSuccess: () => {
      form.reset();
      void queryClient.invalidateQueries({ queryKey: KEYS.sessions });
    },
  });
  const wrong = change.error instanceof ApiError && change.error.status === 403;
  return (
    <Section
      title="Password"
      description="Changing the password signs out every other session. Use at least 12 characters."
    >
      <form
        noValidate
        onSubmit={form.onSubmit((values) => {
          change.mutate(values);
        })}
      >
        <Stack gap="sm" maw={420}>
          {api.kind === 'mock' && (
            <Alert variant="light" color="info" role="note" data-testid="password-preview-note">
              This is a preview. The password only lives in this browser tab and the login page of
              the preview shows it. Do not type a password that you use anywhere else.
            </Alert>
          )}
          {change.isSuccess && (
            <Text size="sm" role="status" data-testid="password-result">
              Password changed. Every other session was signed out.
            </Text>
          )}
          {change.isError && (
            <Alert color="negative" role="alert" data-testid="password-result">
              {wrong ? 'The current password is not right.' : 'The password could not be changed.'}
            </Alert>
          )}
          <PasswordInput
            label="Current password"
            autoComplete="current-password"
            key={form.key('current')}
            {...form.getInputProps('current')}
          />
          <PasswordInput
            label="New password"
            autoComplete="new-password"
            key={form.key('next')}
            {...form.getInputProps('next')}
          />
          <PasswordInput
            label="Repeat the new password"
            autoComplete="new-password"
            key={form.key('confirm')}
            {...form.getInputProps('confirm')}
          />
          <Group>
            <Button type="submit" loading={change.isPending} data-testid="password-submit">
              Change password
            </Button>
          </Group>
        </Stack>
      </form>
    </Section>
  );
}

type TotpStep =
  | { step: 'idle' }
  | { step: 'setup'; setup: TotpSetupResponse }
  | { step: 'codes'; codes: readonly string[] };

function TotpSection() {
  const api = useApi();
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ME_KEY, queryFn: () => api.me() });
  const [state, setState] = useState<TotpStep>({ step: 'idle' });
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const reloadMe = () => queryClient.invalidateQueries({ queryKey: ME_KEY });

  const setup = useMutation({
    mutationFn: () => api.setupTotp(),
    onSuccess: (data) => {
      setCode('');
      setState({ step: 'setup', setup: data });
    },
  });
  const enable = useMutation({
    mutationFn: (value: string) => api.enableTotp({ code: value }),
    onSuccess: async (data) => {
      setCode('');
      setState({ step: 'codes', codes: data.recoveryCodes });
      await reloadMe();
    },
  });
  const disable = useMutation({
    mutationFn: (value: string) => api.disableTotp({ code: value }),
    onSuccess: async () => {
      setCode('');
      await reloadMe();
    },
  });

  const on = me.data?.totpEnabled === true;
  const submit = (run: (value: string) => void) => {
    const problem = validateCode(code);
    setCodeError(problem);
    if (problem === null) run(code);
  };
  const wrongCode = (error: unknown) =>
    error instanceof ApiError && error.code === 'invalid_code' ? 'This code is not right.' : null;

  return (
    <Section
      title="2-step login"
      description="An optional second step at login: a 6-digit code from an authenticator app."
    >
      <Stack gap="sm" maw={520}>
        <Text size="sm" data-testid="totp-state">
          2-step login is {on ? 'on' : 'off'}.
        </Text>

        {state.step === 'codes' && (
          <Alert
            variant="light"
            color="warning"
            role="note"
            title="Your recovery codes"
            data-testid="totp-recovery-codes"
          >
            <Stack gap="xs">
              <Text size="sm">
                Keep these 8 codes somewhere safe. Each works once if you lose your phone. They are
                shown only now.
              </Text>
              <List size="sm" spacing={2} listStyleType="none">
                {state.codes.map((recovery) => (
                  <List.Item key={recovery}>
                    <Code>{recovery}</Code>
                  </List.Item>
                ))}
              </List>
              <Group>
                <Button
                  variant="default"
                  size="xs"
                  onClick={() => {
                    setState({ step: 'idle' });
                  }}
                  data-testid="totp-codes-done"
                >
                  I have saved them
                </Button>
              </Group>
            </Stack>
          </Alert>
        )}

        {state.step === 'idle' && me.data !== undefined && !on && (
          <Group>
            <Button
              variant="default"
              loading={setup.isPending}
              onClick={() => {
                setup.mutate();
              }}
              data-testid="totp-setup"
            >
              Set up 2-step login
            </Button>
          </Group>
        )}

        {state.step === 'setup' && (
          <Stack gap="sm" data-testid="totp-setup-panel">
            <Text size="sm">
              Add this key to your authenticator app, then type the 6-digit code it shows.
            </Text>
            <Text size="sm">
              Key: <Code data-testid="totp-secret">{state.setup.secret}</Code>
            </Text>
            <Text size="xs" c="dimmed" style={{ wordBreak: 'break-all' }}>
              Or open this link on the phone that has the app: {state.setup.otpauthUrl}
            </Text>
            {api.kind === 'mock' && api.preview?.totp !== undefined && (
              <Text size="xs" c="dimmed">
                In this preview the code is {api.preview.totp}.
              </Text>
            )}
            <TextInput
              label="Code from your app"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(event) => {
                setCode(event.currentTarget.value);
              }}
              error={codeError ?? wrongCode(enable.error)}
              data-testid="totp-code"
            />
            <Group>
              <Button
                loading={enable.isPending}
                onClick={() => {
                  submit((value) => {
                    enable.mutate(value);
                  });
                }}
                data-testid="totp-enable"
              >
                Turn on
              </Button>
              <Button
                variant="default"
                onClick={() => {
                  setState({ step: 'idle' });
                  setCode('');
                  setCodeError(null);
                }}
              >
                Cancel
              </Button>
            </Group>
          </Stack>
        )}

        {on && state.step === 'idle' && (
          <Stack gap="sm">
            <TextInput
              label="Code from your app, to turn it off"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(event) => {
                setCode(event.currentTarget.value);
              }}
              error={codeError ?? wrongCode(disable.error)}
              data-testid="totp-disable-code"
            />
            <Group>
              <Button
                variant="default"
                loading={disable.isPending}
                onClick={() => {
                  submit((value) => {
                    disable.mutate(value);
                  });
                }}
                data-testid="totp-disable"
              >
                Turn off 2-step login
              </Button>
            </Group>
          </Stack>
        )}
      </Stack>
    </Section>
  );
}

function SessionsTable({
  sessions,
  onRevoke,
}: {
  sessions: readonly SessionInfo[];
  onRevoke: (session: SessionInfo) => void;
}) {
  return (
    <ScrollBox label="Active sessions, scrolls sideways">
      <Table
        verticalSpacing={6}
        horizontalSpacing="xs"
        fz="sm"
        miw={560}
        data-testid="sessions-table"
      >
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Started</Table.Th>
            <Table.Th>Last seen</Table.Th>
            <Table.Th>Expires</Table.Th>
            <Table.Th>
              <VisuallyHidden>Action</VisuallyHidden>
            </Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {sessions.map((session) => (
            <Table.Tr key={session.id} data-testid={`session-${session.id}`}>
              <Table.Td>
                <TimeText iso={session.createdAt} withDate />
              </Table.Td>
              <Table.Td>
                <TimeText iso={session.lastSeenAt} withDate />
              </Table.Td>
              <Table.Td>
                <TimeText iso={session.expiresAt} withDate />
              </Table.Td>
              <Table.Td>
                {session.current ? (
                  <ToneBadge tone="brand" size="sm">
                    This device
                  </ToneBadge>
                ) : (
                  <Button
                    variant="default"
                    size="xs"
                    onClick={() => {
                      onRevoke(session);
                    }}
                    data-testid={`session-revoke-${session.id}`}
                  >
                    Revoke
                  </Button>
                )}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </ScrollBox>
  );
}

function SessionsSection() {
  const api = useApi();
  const queryClient = useQueryClient();
  const sessions = useSessions();
  const [revoking, setRevoking] = useState<SessionInfo | null>(null);
  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeSession(id),
    onSettled: () => {
      setRevoking(null);
      void queryClient.invalidateQueries({ queryKey: KEYS.sessions });
    },
  });
  return (
    <Section
      title="Active sessions"
      description="Every browser that is signed in. Revoke one that you do not recognise: it is signed out at once. To end this one, use Log out."
    >
      <QueryBoundary query={sessions} what="the sessions">
        {({ items }) => (
          <SessionsTable
            sessions={items}
            onRevoke={(session) => {
              setRevoking(session);
            }}
          />
        )}
      </QueryBoundary>
      {revoke.isError && (
        <Text role="alert" className="text-negative" size="sm">
          The session could not be revoked.
        </Text>
      )}
      <ConfirmDialog
        opened={revoking !== null}
        title="Revoke this session?"
        confirmLabel="Revoke session"
        testId="session-revoke-confirm"
        loading={revoke.isPending}
        onClose={() => {
          setRevoking(null);
        }}
        onConfirm={() => {
          if (revoking) revoke.mutate(revoking.id);
        }}
      >
        The browser that uses it is signed out at once and has to log in again.
      </ConfirmDialog>
    </Section>
  );
}

export function SecurityTab() {
  return (
    <Stack gap="md">
      <PasswordSection />
      <TotpSection />
      <SessionsSection />
    </Stack>
  );
}
