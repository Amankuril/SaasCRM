import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setMailer, type MailMessage } from '../src/lib/mailer.js';
import { LoginChallenge } from '../src/modules/auth/loginChallenge.model.js';
import { Session } from '../src/modules/auth/session.model.js';
import { User } from '../src/modules/auth/user.model.js';
import { api, refreshCookie, signup } from './helpers.js';

let mail: MailMessage[];
beforeEach(() => {
  mail = [];
  setMailer({ send: async (m) => void mail.push(m) });
});
afterEach(() => setMailer(undefined));

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0';
const lastCode = () => /\b(\d{6})\b/.exec(mail.at(-1)!.text)![1]!;

async function passwordStep(email: string, ua = CHROME) {
  const res = await api().post('/api/auth/login').set('User-Agent', ua).send({ email, password: 'password123' }).expect(200);
  return res.body as { otpRequired: boolean; challengeToken: string; email: string };
}
const verify = (body: object, ua = CHROME) => api().post('/api/auth/login/verify').set('User-Agent', ua).send(body);

describe('business login with an emailed code', () => {
  it('emails a code after the password and only starts a session once it is entered', async () => {
    const user = await signup({ email: 'otp@example.com' });
    await Session.deleteMany({ userId: user.id }); // the signup session would count as "logged in elsewhere"

    const step = await passwordStep(user.email);
    expect(step).toMatchObject({ otpRequired: true, email: 'ot**@example.com' });
    expect(mail).toHaveLength(1);
    expect(mail[0]).toMatchObject({ to: 'otp@example.com', subject: expect.stringMatching(/^\d{6} is your Zeta Connect login code$/) });
    expect(mail[0]!.text).toContain('Chrome on Windows');
    // Nothing secret is stored in the clear.
    const stored = await LoginChallenge.findOne().lean();
    expect(JSON.stringify(stored)).not.toContain(lastCode());

    const wrong = await verify({ challengeToken: step.challengeToken, code: lastCode() === '000000' ? '111111' : '000000' }).expect(400);
    expect(wrong.body.error).toMatchObject({ code: 'INVALID_CODE', message: 'That code is not right. 4 attempts left.' });
    await verify({ challengeToken: 'forged', code: lastCode() }).expect(401);

    const ok = await verify({ challengeToken: step.challengeToken, code: lastCode() }).expect(200);
    expect(ok.body.accessToken).toEqual(expect.any(String));
    expect(refreshCookie(ok.headers)).toMatch(/^zc_rt=/);
    expect((await User.findById(user.id))!.emailVerifiedAt).toBeInstanceOf(Date);
    // A challenge works once.
    expect((await verify({ challengeToken: step.challengeToken, code: lastCode() }).expect(401)).body.error.code).toBe('CHALLENGE_EXPIRED');
  });

  it('locks the challenge after 5 wrong codes and limits resends', async () => {
    const user = await signup();
    const step = await passwordStep(user.email);
    const bad = lastCode() === '123456' ? '654321' : '123456';
    for (let i = 0; i < 4; i++) await verify({ challengeToken: step.challengeToken, code: bad }).expect(400);
    expect((await verify({ challengeToken: step.challengeToken, code: bad }).expect(401)).body.error.code).toBe('CHALLENGE_EXPIRED');
    await verify({ challengeToken: step.challengeToken, code: lastCode() }).expect(401);

    const again = await passwordStep(user.email);
    expect((await api().post('/api/auth/login/resend').send({ challengeToken: again.challengeToken }).expect(429)).body.error.code).toBe('RESEND_TOO_SOON');
    await LoginChallenge.updateMany({}, { lastSentAt: new Date(Date.now() - 60_000) });
    const first = lastCode();
    await api().post('/api/auth/login/resend').send({ challengeToken: again.challengeToken }).expect(200);
    expect(mail).toHaveLength(3);
    // Only the newest code works (unless the two happen to match).
    if (first !== lastCode()) await verify({ challengeToken: again.challengeToken, code: first }).expect(400);
  });

  it('asks before replacing a session open in another browser, then closes that one', async () => {
    const user = await signup({ email: 'single@example.com' });
    const chromeSession = user; // signed up (and so logged in) in Chrome

    const step = await passwordStep(user.email, FIREFOX);
    const conflict = await verify({ challengeToken: step.challengeToken, code: lastCode() }, FIREFOX).expect(409);
    expect(conflict.body.error).toMatchObject({ code: 'SESSION_ACTIVE', details: { device: 'an unknown browser', lastSeenAt: expect.any(String) } });

    // "Log in here": the code was already accepted, so only force is needed.
    const ok = await verify({ challengeToken: step.challengeToken, force: true }, FIREFOX).expect(200);
    await api().get('/api/auth/me').set('Authorization', `Bearer ${ok.body.accessToken}`).expect(200);

    // The Chrome tab finds out on its next request or refresh.
    const me = await api().get('/api/auth/me').set('Authorization', `Bearer ${chromeSession.token}`).expect(401);
    expect(me.body.error.code).toBe('SESSION_REPLACED');
    expect((await api().post('/api/auth/refresh').set('Cookie', chromeSession.cookie).expect(401)).body.error.code).toBe('SESSION_REPLACED');
    await api().post('/api/auth/heartbeat').set('Authorization', `Bearer ${chromeSession.token}`).expect(401);

    // A session nobody has used for a while (browser closed) doesn't block a login.
    await Session.updateMany({}, { lastSeenAt: new Date(Date.now() - 10 * 60_000) });
    const later = await passwordStep(user.email, CHROME);
    await verify({ challengeToken: later.challengeToken, code: lastCode() }).expect(200);
    expect(await Session.countDocuments({ userId: user.id, revokedAt: null })).toBe(1);
  });

  it('keeps the open session marked as in use through heartbeats', async () => {
    const user = await signup();
    await Session.updateMany({}, { lastSeenAt: new Date(Date.now() - 10 * 60_000) });
    await api().post('/api/auth/heartbeat').set('Authorization', `Bearer ${user.token}`).expect(204);
    const step = await passwordStep(user.email);
    await verify({ challengeToken: step.challengeToken, code: lastCode() }).expect(409);
  });
});

describe('failed password lockout', () => {
  it('locks business logins after 5 wrong passwords, warning as it gets close', async () => {
    const user = await signup({ email: 'lock@example.com' });
    const tryWrong = () => api().post('/api/auth/login').send({ email: user.email, password: 'nope-nope' });
    for (let i = 0; i < 3; i++) expect((await tryWrong()).body.error.message).toMatch(/^Incorrect email or password\.( \d attempts? left)?/);
    expect((await tryWrong()).body.error.message).toContain('1 attempt left');
    const locked = await tryWrong();
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('LOGIN_LOCKED');
    // Even the right password waits out the lock.
    expect((await api().post('/api/auth/login').send({ email: user.email, password: 'password123' })).body.error.code).toBe('LOGIN_LOCKED');
    expect(mail).toHaveLength(0);
  });

  it('locks the Super Admin portal after 3, separately from business logins', async () => {
    const admin = await signup({ email: 'boss@example.com' });
    await User.updateOne({ email: admin.email }, { isPlatformAdmin: true });
    const wrong = () => api().post('/api/auth/login').send({ email: admin.email, password: 'nope-nope', portal: 'admin' });
    await wrong().expect(401);
    await wrong().expect(401);
    expect((await wrong().expect(429)).body.error.code).toBe('LOGIN_LOCKED');
    await api().post('/api/auth/login').send({ email: admin.email, password: 'password123', portal: 'admin' }).expect(429);
    // Admin sign-in stays password-only and is not limited to one session.
    await api().post('/api/auth/login').send({ email: admin.email, password: 'password123' }).expect(200);
  });

  it('does not reveal unknown emails differently', async () => {
    const res = await api().post('/api/auth/login').send({ email: 'ghost@example.com', password: 'whatever1' });
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });
});
