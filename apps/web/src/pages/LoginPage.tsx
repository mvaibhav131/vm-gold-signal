import {
  Alert,
  Box,
  Button,
  Container,
  List,
  Paper,
  PasswordInput,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Navigate, useLocation, useNavigate } from 'react-router';

import { ApiError } from '../api/client';
import { useApi } from '../api/context';
import { emptyLoginForm, toLoginRequest, validateLoginForm } from '../auth/loginForm';
import { safeRedirectTarget } from '../auth/redirect';
import { ME_KEY } from '../auth/RequireAuth';
import { usePageTitle } from '../hooks';
import { ThemeToggle } from '../layout/ThemeToggle';

const GENERIC_ERROR = 'Login failed. Check your details and try again.';
const THROTTLED_ERROR = 'Too many attempts. Please wait a few minutes and try again.';

/** Login: no sign-up and no forgot-password link, and one generic error for every failure. */
export function LoginPage() {
  usePageTitle('Log in');
  const api = useApi();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ME_KEY, queryFn: () => api.me() });
  const form = useForm({
    mode: 'uncontrolled',
    initialValues: emptyLoginForm,
    validate: validateLoginForm,
  });
  const login = useMutation({
    mutationFn: (values: typeof emptyLoginForm) => api.login(toLoginRequest(values)),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ME_KEY });
      void navigate(safeRedirectTarget(location.state), { replace: true });
    },
  });

  if (me.data) return <Navigate to={safeRedirectTarget(location.state)} replace />;

  const errorText =
    login.error instanceof ApiError && login.error.status === 429 ? THROTTLED_ERROR : GENERIC_ERROR;

  return (
    <Box component="main" mih="100vh" py="xl" pos="relative">
      <Box pos="absolute" top={16} right={16}>
        <ThemeToggle />
      </Box>
      <Container size={420}>
        <Stack gap="lg">
          <Stack gap={4}>
            <Title order={1} size="h2" className="brand">
              VM Gold Signal
            </Title>
            <Text c="dimmed">Private XAU/USD decision support. Log in to continue.</Text>
          </Stack>

          <Paper withBorder p="lg" radius="md">
            <form
              noValidate
              onSubmit={form.onSubmit((values) => {
                login.mutate(values);
              })}
            >
              <Stack gap="md">
                {login.isError && (
                  <Alert color="negative" variant="light" role="alert" data-testid="login-error">
                    {errorText}
                  </Alert>
                )}
                <TextInput
                  label="Username"
                  autoComplete="username"
                  required
                  key={form.key('username')}
                  {...form.getInputProps('username')}
                />
                <PasswordInput
                  label="Password"
                  autoComplete="current-password"
                  required
                  key={form.key('password')}
                  {...form.getInputProps('password')}
                />
                <TextInput
                  label="Authenticator code (only if you turned on 2-step login)"
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  maxLength={6}
                  key={form.key('totp')}
                  {...form.getInputProps('totp')}
                />
                <Button type="submit" fullWidth loading={login.isPending}>
                  Log in
                </Button>
              </Stack>
            </form>
          </Paper>

          {api.preview !== undefined && (
            <Alert
              color="info"
              variant="light"
              title="Preview with simulated data"
              data-testid="login-preview-hint"
            >
              <List size="sm" spacing={2}>
                <List.Item>
                  Username: <b>{api.preview.username}</b>
                </List.Item>
                <List.Item>
                  Password: <b>{api.preview.password}</b>
                </List.Item>
              </List>
              <Text size="sm" mt="xs">
                Every number you see in this preview is simulated.
              </Text>
            </Alert>
          )}
        </Stack>
      </Container>
    </Box>
  );
}
