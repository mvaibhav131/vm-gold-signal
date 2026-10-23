import type { RouteObject } from 'react-router';

import { RequireAuth } from './auth/RequireAuth';
import { AppLayout } from './layout/AppLayout';
import { LoginPage } from './pages/LoginPage';
import {
  AnalyticsPage,
  DashboardPage,
  NewsPage,
  NotFoundPage,
  SignalDetailPage,
  SignalsPage,
  SystemPage,
} from './pages/pages';

/** Routes of 05_UI_Spec section 2. Everything except /login sits behind RequireAuth. */
export const appRoutes: RouteObject[] = [
  { path: '/login', element: <LoginPage /> },
  {
    element: (
      <RequireAuth>
        <AppLayout />
      </RequireAuth>
    ),
    children: [
      { index: true, element: <DashboardPage /> },
      { path: 'signals', element: <SignalsPage /> },
      { path: 'signals/:id', element: <SignalDetailPage /> },
      { path: 'analytics', element: <AnalyticsPage /> },
      { path: 'news', element: <NewsPage /> },
      { path: 'system', element: <SystemPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];
