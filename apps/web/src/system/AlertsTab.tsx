import {
  Alert,
  Button,
  Checkbox,
  Group,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Text,
} from '@mantine/core';
import type { Settings, SettingsPatch } from '@vmgs/contracts';
import { GRADES, NEWS_IMPACTS, NEWS_TOPICS, STRATEGY_KEYS, type Grade } from '@vmgs/core';
import { useMutation } from '@tanstack/react-query';

import { useApi } from '../api/context';
import { ApiError } from '../api/client';
import { QueryBoundary, Section } from '../components/page';
import { useUpdateSettings } from '../data/mutations';
import { useSettings } from '../data/queries';
import { IMPACT_LABELS, TOPIC_LABELS } from '../format/news';
import { STRATEGY_LABELS } from '../format/signal';
import { GATE_KEYS, GATE_TEXT, KIND_LABELS, SELECTABLE_KINDS, orderedKinds } from './alerts';

type Patch = (patch: SettingsPatch) => void;

const gradeOptions = GRADES.map((grade) => ({ value: grade, label: grade }));

function pickGrade(value: string | null): Grade | undefined {
  return GRADES.find((grade) => grade === value);
}

function TelegramSection({ settings, save }: { settings: Settings; save: Patch }) {
  const api = useApi();
  const test = useMutation({ mutationFn: () => api.sendTestNotification({ channel: 'telegram' }) });
  const telegram = settings.alerts.telegram;
  return (
    <Section
      title="Telegram"
      description="Signal and news alerts go to your Telegram chat. A paper strategy's message always starts with FORWARD-TEST (paper)."
    >
      <Stack gap="md">
        <Switch
          label="Telegram alerts"
          checked={telegram.enabled}
          onChange={(event) => {
            save({ alerts: { telegram: { enabled: event.currentTarget.checked } } });
          }}
          data-testid="alerts-telegram-switch"
        />
        <Select
          label="Telegram: minimum grade of a signal"
          description="A signal below this grade is not sent to Telegram."
          data={gradeOptions}
          value={telegram.minGrade}
          onChange={(value) => {
            const minGrade = pickGrade(value);
            if (minGrade) save({ alerts: { telegram: { minGrade } } });
          }}
          allowDeselect={false}
          maw={260}
          data-testid="alerts-telegram-grade"
        />
        <Checkbox.Group
          label="Send a message for"
          value={[...telegram.kinds]}
          onChange={(values) => {
            save({ alerts: { telegram: { kinds: orderedKinds(values) } } });
          }}
          data-testid="alerts-telegram-kinds"
        >
          <Group gap="md" mt="xs">
            {SELECTABLE_KINDS.map((kind) => (
              <Checkbox key={kind} value={kind} label={KIND_LABELS[kind]} />
            ))}
          </Group>
        </Checkbox.Group>

        <Stack gap={6}>
          <Group gap="sm">
            <Button
              variant="default"
              loading={test.isPending}
              onClick={() => {
                test.mutate();
              }}
              data-testid="alerts-test-button"
            >
              Send test message
            </Button>
            <Text size="xs" c="dimmed">
              The message says that it is a test.
            </Text>
          </Group>
          {test.isSuccess && (
            <Text size="sm" role="status" data-testid="alerts-test-result">
              Test message queued ({test.data.eventKey}). It is sent by the worker within a few
              seconds.
            </Text>
          )}
          {test.isError && (
            <Text size="sm" role="alert" className="text-negative" data-testid="alerts-test-result">
              {test.error instanceof ApiError
                ? test.error.message
                : 'The test message could not be queued.'}
            </Text>
          )}
        </Stack>
      </Stack>
    </Section>
  );
}

function WebPushSection({ settings, save }: { settings: Settings; save: Patch }) {
  const push = settings.alerts.webpush;
  return (
    <Section title="Web Push" description="Alerts on this phone or computer, without Telegram.">
      <Stack gap="md">
        <Switch
          label="Web Push alerts"
          checked={push.enabled}
          onChange={(event) => {
            save({ alerts: { webpush: { enabled: event.currentTarget.checked } } });
          }}
          data-testid="alerts-webpush-switch"
        />
        <Select
          label="Web Push: minimum grade of a signal"
          data={gradeOptions}
          value={push.minGrade}
          onChange={(value) => {
            const minGrade = pickGrade(value);
            if (minGrade) save({ alerts: { webpush: { minGrade } } });
          }}
          allowDeselect={false}
          maw={260}
          data-testid="alerts-webpush-grade"
        />
        <Group gap="sm">
          <Button variant="default" disabled data-testid="alerts-webpush-subscribe">
            Subscribe this device
          </Button>
          <Button variant="default" disabled data-testid="alerts-webpush-test">
            Send test notification
          </Button>
        </Group>
        <Text size="sm" c="dimmed" data-testid="alerts-webpush-note">
          Subscribing a device needs the service worker of the app, which is built in phase U6.
          Until then no device can receive Web Push, and these two buttons stay off.
        </Text>
      </Stack>
    </Section>
  );
}

function AlertsForm({ settings, save }: { settings: Settings; save: Patch }) {
  return (
    <Stack gap="md">
      <TelegramSection settings={settings} save={save} />
      <WebPushSection settings={settings} save={save} />

      <Section
        title="Message language"
        description="Only the words of the messages change. The numbers and the levels are the same in both languages."
      >
        <SegmentedControl
          aria-label="Message language"
          data={[
            { value: 'en', label: 'English' },
            { value: 'hinglish', label: 'Hinglish' },
          ]}
          value={settings.locale}
          onChange={(value) => {
            save({ locale: value });
          }}
          data-testid="alerts-locale"
        />
      </Section>

      <Section
        title="Advisory flags"
        description="Warn: the signal is sent with a warning. Block: no signal is sent while the flag is on."
      >
        <Stack gap="md">
          {GATE_KEYS.map((key) => (
            <Group key={key} justify="space-between" align="center" wrap="wrap">
              <div>
                <Text fw={600} size="sm">
                  {GATE_TEXT[key].label}
                </Text>
                <Text size="xs" c="dimmed" maw={480}>
                  {GATE_TEXT[key].description}
                </Text>
              </div>
              <SegmentedControl
                aria-label={`${GATE_TEXT[key].label} flag`}
                data={[
                  { value: 'warn', label: 'Warn' },
                  { value: 'block', label: 'Block' },
                ]}
                value={settings.advisoryGates[key]}
                onChange={(value) => {
                  save({ advisoryGates: { [key]: value } });
                }}
                data-testid={`advisory-${key}`}
              />
            </Group>
          ))}
        </Stack>
      </Section>

      <Section
        title="Alerts by strategy"
        description="The same switch as on the Strategies tab: a strategy that does not alert still records its signals and results."
      >
        <Stack gap="sm">
          {STRATEGY_KEYS.map((key) => (
            <Switch
              key={key}
              label={STRATEGY_LABELS[key]}
              checked={settings.strategyAlerts[key] === 'on'}
              onChange={(event) => {
                save({ strategyAlerts: { [key]: event.currentTarget.checked ? 'on' : 'off' } });
              }}
              data-testid={`alerts-strategy-${key}`}
            />
          ))}
        </Stack>
      </Section>

      <Section
        title="Headline and move alerts"
        description="Both are information for you: they never create or block a signal."
      >
        <Stack gap="md">
          <Select
            label="Alert for headlines of this impact and above"
            data={NEWS_IMPACTS.map((impact) => ({ value: impact, label: IMPACT_LABELS[impact] }))}
            value={settings.newsAlerts.minImpact}
            onChange={(value) => {
              const minImpact = NEWS_IMPACTS.find((impact) => impact === value);
              if (minImpact) save({ newsAlerts: { minImpact } });
            }}
            allowDeselect={false}
            maw={260}
            data-testid="alerts-news-min-impact"
          />
          <Stack gap="xs">
            <Text size="sm" fw={600}>
              Topics
            </Text>
            <Group gap="lg">
              {NEWS_TOPICS.map((topic) => (
                <Switch
                  key={topic}
                  label={TOPIC_LABELS[topic]}
                  checked={settings.newsAlerts.topics[topic] === 'on'}
                  onChange={(event) => {
                    save({
                      newsAlerts: {
                        topics: { [topic]: event.currentTarget.checked ? 'on' : 'off' },
                      },
                    });
                  }}
                  data-testid={`alerts-topic-${topic}`}
                />
              ))}
            </Group>
          </Stack>
          <Switch
            label="Alert for sudden moves of gold"
            checked={settings.newsAlerts.marketMoves === 'on'}
            onChange={(event) => {
              save({ newsAlerts: { marketMoves: event.currentTarget.checked ? 'on' : 'off' } });
            }}
            data-testid="alerts-market-moves"
          />
        </Stack>
      </Section>
    </Stack>
  );
}

/** The state of the last save, in words, for screen readers too. */
function SaveStatus({ state }: { state: 'idle' | 'pending' | 'success' | 'error' }) {
  if (state === 'error') {
    return (
      <Alert
        color="negative"
        role="alert"
        title="The change could not be saved"
        data-testid="alerts-status"
      >
        Nothing was changed. Check the connection and try again.
      </Alert>
    );
  }
  return (
    <Text size="sm" c="dimmed" role="status" data-testid="alerts-status">
      {state === 'pending'
        ? 'Saving…'
        : state === 'success'
          ? 'Saved'
          : 'Changes are saved as you make them.'}
    </Text>
  );
}

export function AlertsTab() {
  const settings = useSettings();
  const update = useUpdateSettings();
  return (
    <Stack gap="md">
      <SaveStatus state={update.status} />
      <QueryBoundary query={settings} what="the settings">
        {(data) => (
          <AlertsForm
            settings={data}
            save={(patch) => {
              update.mutate(patch);
            }}
          />
        )}
      </QueryBoundary>
    </Stack>
  );
}
