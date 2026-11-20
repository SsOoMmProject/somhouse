import io
import json
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import parse_qs, urlencode, urlsplit

import chatgpt_plan as plan
from ai import AIError
from server import Store

try:
    import jwt
    from cryptography.hazmat.primitives.asymmetric import rsa
except ImportError:
    jwt = None


class ResponseStream(unittest.TestCase):
    def test_requires_a_completed_answer_and_reports_late_limits(self):
        def stream(*events):
            return io.BytesIO(b''.join(b'data: ' + json.dumps(event).encode() + b'\n\n' for event in events))
        delta = {'type': 'response.output_text.delta', 'delta': 'partial'}
        message = {'type': 'message', 'content': [{'type': 'output_text', 'text': '안녕'}]}
        completed = {'type': 'response.completed', 'response': {'output': [message]}}
        self.assertEqual(plan.read_answer(stream(delta, completed))['answer'], '안녕')
        for event in (delta, {'type': 'response.incomplete'}, {'type': 'response.completed', 'response': {}}):
            with self.assertRaises(AIError):
                plan.read_answer(stream(event))
        failed = {'type': 'response.failed', 'response': {'error': {'code': 'subscription_sharing_usage_limit_exceeded'}}}
        with self.assertRaises(AIError) as cm:
            plan.read_answer(stream(delta, failed))
        self.assertEqual(cm.exception.status, 429)


@unittest.skipUnless(jwt, 'optional ChatGPT plan dependencies')
class PersonalPlan(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.signer = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.store = Store(Path(folder.name))
        self.plan = plan.ChatGPTPlan.load(self.store.directory, 18764)
        with self.store.connect() as db:
            self.owner = self.store.new_session(db, 'family')
            self.other = self.store.new_session(db, 'family')  # Same family and same login name on a second device.
        self.client = 'oaiapp_test'
        self.tokens = {'access_token': 'personal-access', 'refresh_token': 'personal-refresh', 'expires_in': 3600,
                       'token_type': 'Bearer', 'scope': plan.SCOPES}
        self.catalog = [{'visibility': 'hide', 'slug': 'hidden'},
                        {'visibility': 'list', 'slug': 'available'},
                        {'visibility': 'list', 'slug': 'second', 'display_name': '두 번째'}]
        self.calls = []
        self.enterContext(patch.object(self.plan.keys, 'get_signing_key_from_jwt', return_value=SimpleNamespace(key=self.signer.public_key())))
        self.enterContext(patch.object(plan, 'request', side_effect=self.remote))

    def remote(self, url, **args):
        self.calls.append((url, args))
        if url.endswith('/token'):
            if args['fields']['grant_type'] == 'refresh_token':
                return dict(self.tokens, access_token='renewed', refresh_token='rotated')
            return self.tokens
        if url.endswith('/models'):
            return {'models': self.catalog}
        if url.endswith('/responses'):
            return {'answer': '내 구독 답변', 'truncated': False}
        if url.endswith('/revoke'):
            return {}
        self.fail(url)

    def start(self):
        with self.store.connect() as db:
            grant = plan.profile(db, plan.session_key(self.owner))
        args = parse_qs(urlsplit(self.plan.start(self.owner, grant)['url']).query)
        self.assertEqual(args['client_id'], [self.client if grant else 'dynamic_agent_client'])
        self.assertIn(plan.PERMISSION, args['scope'][0])
        now = int(time.time())
        self.claims = dict(iss=plan.ISSUER, aud=self.client, sub='user1', email='member@example.test', email_verified=True,
                           nonce=args['nonce'][0], iat=now, exp=now+600)
        self.tokens['id_token'] = jwt.encode(self.claims, self.signer, algorithm='RS256')
        callback = urlencode(dict(code='test-code', client_id=self.client, state=args['state'][0]))
        target = self.plan.callback(callback)
        self.assertNotIn('test-code', target)
        self.assertIn('expired', self.plan.callback(callback))
        return target.split('#chatgpt=')[1]

    def test_personal_grant_lifecycle_isolated_from_same_login_and_backup(self):
        self.plan.finish(self.store, self.owner, self.start())
        with self.store.connect() as db:
            key = plan.session_key(self.owner)
            first = plan.profile(db, key)
            self.assertEqual(first['email'], 'member@example.test')
            self.assertEqual(plan.profile(db, plan.session_key(self.other)), {})
            self.assertNotIn('personal-', self.store.snapshot(db).read_text())
            db.execute('UPDATE chatgpt_sessions SET profile=? WHERE session=?', (json.dumps(dict(first, expires=0)), key))
        with self.assertRaises(AIError):
            self.plan.ask(self.store, self.other, '안녕')
        self.assertEqual(self.plan.ask(self.store, self.owner, '안녕')['answer'], '내 구독 답변')
        endpoint, req = self.calls[-1]
        self.assertEqual(endpoint, 'https://api.openai.com/v1/responses')
        self.assertEqual(req['headers'], {'Authorization': 'Bearer renewed'})
        self.assertFalse(req['payload']['store'])
        self.assertTrue(req['payload']['stream'])
        self.assertEqual(req['payload']['model'], 'available')
        self.assertEqual(req['payload']['input'], '안녕')
        with self.store.connect() as db:
            self.assertEqual(plan.profile(db, key)['refresh'], 'rotated')
        self.assertTrue(self.plan.disconnect(self.store, self.owner)['revoked'])
        self.assertEqual(self.calls[-1][1]['fields']['token'], 'rotated')
        with self.assertRaises(AIError):
            self.plan.ask(self.store, self.owner, '안녕')

    def test_picker_upgrades_existing_session_and_sends_only_a_listed_model(self):
        self.plan.finish(self.store, self.owner, self.start())
        key = plan.session_key(self.owner)
        with self.store.connect() as db:
            old = plan.profile(db, key)
        del old['models']
        plan.save(self.store, self.owner, old)
        self.catalog.extend([{'visibility': 'list', 'slug': 'second'}, {'visibility': 'list'}, None])
        catalog = self.plan.models(self.store, self.owner)
        self.assertEqual(catalog['models'], [{'slug': 'available', 'name': 'available'},
                                             {'slug': 'second', 'name': '두 번째'}])
        self.assertEqual(set(catalog), {'connected', 'email', 'model', 'models'})
        self.assertEqual(catalog['model'], 'available')
        with self.assertRaises(AIError):
            self.plan.models(self.store, self.other)
        for invalid in ('hidden', '', {'slug': 'second'}):
            with self.assertRaises(AIError):
                self.plan.ask(self.store, self.owner, 'hello', invalid)
        self.assertFalse(any(url.endswith('/responses') for url, _ in self.calls))
        self.plan.ask(self.store, self.owner, 'hello', 'second')
        self.assertEqual(self.calls[-1][1]['payload']['model'], 'second')
        self.assertEqual(self.plan.models(self.store, self.owner)['model'], 'second')
        self.catalog = self.catalog[:2]
        self.assertEqual(self.plan.models(self.store, self.owner)['model'], 'available')
        with self.assertRaises(AIError):
            self.plan.ask(self.store, self.owner, 'hello', 'second')
        self.catalog = []
        self.assertEqual(self.plan.models(self.store, self.owner)['models'], [])
        with self.assertRaises(AIError):
            self.plan.ask(self.store, self.owner, 'hello')

    def test_cross_session_receipt_declined_scope_and_forged_id_token(self):
        receipt = self.start()
        with self.assertRaises(AIError):
            self.plan.finish(self.store, self.other, receipt)
        with self.assertRaises(AIError):
            self.plan.finish(self.store, self.owner, receipt)
        receipt = self.start()
        self.tokens['scope'] = 'openid'
        with self.assertRaises(AIError):
            self.plan.finish(self.store, self.owner, receipt)
        self.tokens['scope'] = plan.SCOPES
        for field, value in [('aud', 'another-client'), ('nonce', 'another-request'), ('iss', 'other'), ('exp', 1)]:
            receipt = self.start()
            self.tokens['id_token'] = jwt.encode(dict(self.claims, **{field: value}), self.signer, algorithm='RS256')
            with self.assertRaises(AIError):
                self.plan.finish(self.store, self.owner, receipt)
        self.assertFalse(any(url.endswith('/models') for url, _ in self.calls))

    def test_hosted_uses_assigned_client_and_registered_https_callback(self):
        self.plan = plan.ChatGPTPlan('https://somhouse.example/auth/openai/callback', 'https://app.example/', client=self.client)
        args = parse_qs(urlsplit(self.plan.start(self.owner, {})['url']).query)
        self.assertEqual(args['client_id'], [self.client])
        self.assertNotIn('ext_agent_host_id', args)
        self.assertEqual(args['redirect_uri'], [self.plan.redirect])
        target = self.plan.callback(urlencode(dict(state=args['state'][0], code='x', client_id='oaiapp_wrong')))
        self.assertEqual(target, self.plan.frontend+'#chatgpt-error=registration')

    def test_logout_drops_private_grant_and_cannot_restore_it(self):
        self.plan.finish(self.store, self.owner, self.start())
        receipt = self.start()
        with self.store.connect() as db:
            key = plan.session_key(self.owner)
            db.execute('DELETE FROM sessions WHERE token=?', (key,))
            self.assertEqual(plan.profile(db,key), {})
        with self.assertRaises(AIError):
            self.plan.finish(self.store, self.owner, receipt)
