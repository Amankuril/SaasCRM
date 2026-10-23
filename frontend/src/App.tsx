import { lazy, Suspense, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router';
import { useAuth } from './auth/AuthContext';
import { Spinner } from './components/ui';
import { WorkspaceLayout } from './layouts/WorkspaceLayout';
import { AcceptInvitePage } from './pages/AcceptInvitePage';
import { AdminPage } from './pages/AdminPage';
import { AuditLogPage } from './pages/AuditLogPage';
import { DashboardPage } from './pages/DashboardPage';
import { LoginPage } from './pages/LoginPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { OnboardingPage } from './pages/OnboardingPage';
import { SettingsPage } from './pages/SettingsPage';
import { SignupPage } from './pages/SignupPage';
import { TeamPage } from './pages/TeamPage';
import { ContactsPage } from './pages/ContactsPage';
import { CampaignPage } from './pages/CampaignPage';
import { FlowsPage } from './pages/FlowsPage';
import { AiAgentPage } from './pages/AiAgentPage';
import { DeveloperPage } from './pages/DeveloperPage';
import { BillingPage } from './pages/BillingPage';
import { AnalyticsPage } from './pages/AnalyticsPage';
import { FormBuilderPage } from './pages/FormBuilderPage';
import { FormsPage } from './pages/FormsPage';
import { CampaignsPage } from './pages/CampaignsPage';
import { InboxPage } from './pages/InboxPage';
import { TemplatesPage } from './pages/TemplatesPage';
import { WhatsAppPage } from './pages/WhatsAppPage';

// The flow builder pulls in React Flow; load it only when opened.
const FlowBuilderPage = lazy(() => import('./pages/FlowBuilderPage').then((m) => ({ default: m.FlowBuilderPage })));

export function App() {
  const { status } = useAuth();
  if (status === 'loading') return <Spinner label="Loading Zeta Connect…" />;

  return (
    <Routes>
      <Route path="/login" element={<GuestOnly><LoginPage /></GuestOnly>} />
      <Route path="/signup" element={<GuestOnly><SignupPage /></GuestOnly>} />
      <Route path="/invite/:token" element={<AcceptInvitePage />} />

      <Route path="/" element={<RequireAuth><HomeRedirect /></RequireAuth>} />
      <Route path="/onboarding" element={<RequireAuth><OnboardingPage /></RequireAuth>} />
      <Route path="/admin" element={<RequireAuth><AdminPage /></RequireAuth>} />

      <Route path="/w/:workspaceId" element={<RequireAuth><WorkspaceLayout /></RequireAuth>}>
        <Route index element={<DashboardPage />} />
        <Route path="team" element={<TeamPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="audit" element={<AuditLogPage />} />
        <Route path="whatsapp" element={<WhatsAppPage />} />
        <Route path="inbox" element={<InboxPage />} />
        <Route path="contacts" element={<ContactsPage />} />
        <Route path="campaigns" element={<CampaignsPage />} />
        <Route path="campaigns/:campaignId" element={<CampaignPage />} />
        <Route path="flows" element={<FlowsPage />} />
        <Route path="forms" element={<FormsPage />} />
        <Route path="forms/:formId" element={<FormBuilderPage />} />
        <Route path="ai" element={<AiAgentPage />} />
        <Route path="developer" element={<DeveloperPage />} />
        <Route path="billing" element={<BillingPage />} />
        <Route path="analytics" element={<AnalyticsPage />} />
        <Route
          path="flows/:flowId"
          element={
            <Suspense fallback={<Spinner label="Loading builder…" />}>
              <FlowBuilderPage />
            </Suspense>
          }
        />
        <Route path="templates" element={<TemplatesPage />} />
      </Route>

      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}

function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const location = useLocation();
  if (status !== 'authenticated') {
    const path = location.pathname + location.search;
    return <Navigate to={path === '/' ? '/login' : `/login?next=${encodeURIComponent(path)}`} replace />;
  }
  return children;
}

function GuestOnly({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const location = useLocation();
  if (status === 'authenticated') {
    const next = new URLSearchParams(location.search).get('next');
    return <Navigate to={safeNext(next)} replace />;
  }
  return children;
}

/** Sends the user to their first workspace, or to onboarding if they have none. */
function HomeRedirect() {
  const { workspaces } = useAuth();
  const first = workspaces[0];
  return <Navigate to={first ? `/w/${first.id}` : '/onboarding'} replace />;
}

/** Only allow same-app relative redirects (no `//evil.com`). */
export function safeNext(next: string | null): string {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
}
