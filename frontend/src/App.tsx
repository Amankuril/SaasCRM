import { lazy, Suspense, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router';
import { useAuth } from './auth/AuthContext';
import { Spinner } from './components/ui';
import { WorkspaceLayout } from './layouts/WorkspaceLayout';
import { AcceptInvitePage } from './pages/AcceptInvitePage';
import { AdminLoginPage } from './pages/AdminLoginPage';
import { AdminPage } from './pages/AdminPage';
import { AuditLogPage } from './pages/AuditLogPage';
import { DashboardPage } from './pages/DashboardPage';
import { LoginPage } from './pages/LoginPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { OnboardingPage } from './pages/OnboardingPage';
import { SettingsPage } from './pages/SettingsPage';
import { SignupPage } from './pages/SignupPage';
import { ContactsPage } from './pages/ContactsPage';
import { CampaignPage } from './pages/CampaignPage';
import { FlowsPage } from './pages/FlowsPage';
import { AiAgentPage } from './pages/AiAgentPage';
import { DeveloperPage } from './pages/DeveloperPage';
import { BillingPage } from './pages/BillingPage';
import { AnalyticsPage } from './pages/AnalyticsPage';
import { FormBuilderPage } from './pages/forms/FormBuilderPage';
import { FormsListPage } from './pages/forms/FormsListPage';
import { CampaignsPage } from './pages/CampaignsPage';
import { InboxPage } from './pages/InboxPage';
import { AudienceLayout } from './pages/audience/AudienceLayout';
import { AudiencePage } from './pages/audience/AudiencePage';
import { FollowUpsPage } from './pages/audience/FollowUpsPage';
import { AppointmentsPage } from './pages/audience/AppointmentsPage';
import { PipelinePage } from './pages/audience/PipelinePage';
import { TaskBoardPage } from './pages/audience/TaskBoardPage';
import { SegmentsPage } from './pages/audience/SegmentsPage';
import { BroadcastLayout } from './pages/broadcast/BroadcastLayout';
import { ContactListsPage } from './pages/broadcast/ContactListsPage';
import { BroadcastGuidePage } from './pages/broadcast/BroadcastGuidePage';
import { RetargetPage } from './pages/broadcast/RetargetPage';
import { AutoRepliesPage } from './pages/autoreplies/AutoRepliesPage';
import { AutoReplyEditorPage } from './pages/autoreplies/AutoReplyEditorPage';
import { AllTemplatesPage } from './pages/templates/AllTemplatesPage';
import { CommunityLibraryPage } from './pages/templates/CommunityLibraryPage';
import { CreateTemplatePage } from './pages/templates/CreateTemplatePage';
import { MetaLibraryPage } from './pages/templates/MetaLibraryPage';
import { TemplatesLayout } from './pages/templates/TemplatesLayout';
import { WhatsAppPage } from './pages/WhatsAppPage';
import { IntegrationsPage } from './pages/integrations/IntegrationsPage';
import { SheetCampaignsPage } from './pages/integrations/SheetCampaignsPage';
import { SheetSetupPage } from './pages/integrations/SheetSetupPage';
import { SheetDataPage } from './pages/integrations/SheetDataPage';

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
      <Route path="/admin/login" element={<AdminGuestOnly><AdminLoginPage /></AdminGuestOnly>} />
      <Route path="/admin" element={<RequireAuth><AdminPage /></RequireAuth>} />

      <Route path="/w/:workspaceId" element={<RequireAuth><WorkspaceLayout /></RequireAuth>}>
        <Route index element={<DashboardPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="audit" element={<AuditLogPage />} />
        <Route path="whatsapp" element={<WhatsAppPage />} />
        <Route path="inbox" element={<InboxPage />} />
        <Route path="contacts" element={<ContactsPage />} />
        <Route path="audience" element={<AudienceLayout />}>
          <Route index element={<AudiencePage />} />
          <Route path="segments" element={<SegmentsPage />} />
          <Route path="follow-ups" element={<FollowUpsPage />} />
          <Route path="pipeline" element={<PipelinePage />} />
          <Route path="tasks" element={<TaskBoardPage />} />
          <Route path="appointments" element={<AppointmentsPage />} />
        </Route>
        <Route element={<BroadcastLayout />}>
          <Route path="broadcast" element={<ContactListsPage />} />
          <Route path="broadcast/guide" element={<BroadcastGuidePage />} />
          <Route path="broadcast/retarget" element={<RetargetPage />} />
          <Route path="campaigns" element={<CampaignsPage />} />
          <Route path="campaigns/:campaignId" element={<CampaignPage />} />
        </Route>
        <Route path="auto-replies" element={<AutoRepliesPage />} />
        <Route path="auto-replies/new" element={<AutoReplyEditorPage />} />
        <Route path="auto-replies/:autoReplyId" element={<AutoReplyEditorPage />} />
        <Route path="flows" element={<FlowsPage />} />
        <Route path="forms" element={<FormsListPage />} />
        <Route path="forms/:formId" element={<FormBuilderPage />} />
        <Route path="ai" element={<AiAgentPage />} />
        <Route path="integrations" element={<IntegrationsPage />} />
        <Route path="integrations/google-sheets" element={<SheetCampaignsPage />} />
        <Route path="integrations/google-sheets/new" element={<SheetSetupPage />} />
        <Route path="integrations/google-sheets/:campaignId/setup" element={<SheetSetupPage />} />
        <Route path="integrations/google-sheets/:campaignId/data" element={<SheetDataPage />} />
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
        <Route path="templates" element={<TemplatesLayout />}>
          <Route index element={<AllTemplatesPage />} />
          <Route path="new" element={<CreateTemplatePage />} />
          <Route path=":templateId/edit" element={<CreateTemplatePage />} />
          <Route path="library" element={<MetaLibraryPage />} />
          <Route path="community" element={<CommunityLibraryPage />} />
        </Route>
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
    // The Super Admin panel has its own login page.
    if (location.pathname.startsWith('/admin')) return <Navigate to="/admin/login" replace />;
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

/** Signed-in admins skip the admin login; other signed-in users go to their app. */
function AdminGuestOnly({ children }: { children: ReactNode }) {
  const { status, user } = useAuth();
  if (status === 'authenticated') return <Navigate to={user?.isPlatformAdmin ? '/admin' : '/'} replace />;
  return children;
}

/**
 * Sends the user to their first workspace. Without one, platform admins go to the
 * Super Admin panel and everyone else to onboarding (create a business).
 */
function HomeRedirect() {
  const { user, workspaces } = useAuth();
  const first = workspaces[0];
  return <Navigate to={first ? `/w/${first.id}` : user?.isPlatformAdmin ? '/admin' : '/onboarding'} replace />;
}

/** Only allow same-app relative redirects (no `//evil.com`). */
export function safeNext(next: string | null): string {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
}
