"""Personal ChatGPT plan connections, bound to the initiating Somhouse login session."""
import base64
import hashlib
from http.client import HTTPException
import json
import re
import secrets
import threading
import time
import uuid
from urllib.error import HTTPError
from urllib.parse import parse_qs, quote_plus, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from ai import AIError, SYSTEM, private_json, reply
from google_web import Pending

ISSUER = 'https://auth.openai.com'
ACCOUNTS = ISSUER + '/api/accounts'
RESOURCE = 'https://api.openai.com/v1'
PERMISSION = 'chatgpt.tokens.use.direct'
SCOPES = 'openid profile email offline_access resource.invoke ' + PERMISSION
CALLBACK = '/auth/openai/callback'
LOCAL_CALLBACK = '/auth/callback'
RECONNECT = 'ChatGPT 구독을 다시 연결해 주세요.'
LIMIT = 'ChatGPT 사용 한도에 도달했어요. 사용량 관리에서 확인해 주세요.'
SCHEMA = '''
CREATE TABLE IF NOT EXISTS chatgpt_sessions(session TEXT PRIMARY KEY, profile TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS clear_chatgpt_session AFTER DELETE ON sessions BEGIN
    DELETE FROM chatgpt_sessions WHERE session=OLD.token;
END;
'''


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None  # Never forward a bearer token or client secret to a redirect target.


http = build_opener(NoRedirect())


def remote_error(status, code):
    if status == 429 or code == 'subscription_sharing_usage_limit_exceeded':
        return AIError(429, LIMIT)
    if code == 'subscription_sharing_usage_unavailable':
        return AIError(503, '지금은 ChatGPT 플랜 사용량을 확인할 수 없어요. 잠시 후 다시 시도해 주세요.')
    if status in (401, 403) or code in ('invalid_grant', 'refresh_token_reused', 'refresh_token_expired'):
        return AIError(409, RECONNECT)
    return AIError(502, 'OpenAI 요청을 마치지 못했어요. 잠시 후 다시 시도해 주세요.')


def request(url, *, fields=None, headers=None, payload=None, stream=False):
    headers = dict(headers or {})
    data = None
    if fields is not None:
        data = urlencode(fields).encode()
        headers['Content-Type'] = 'application/x-www-form-urlencoded'
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode()
        headers['Content-Type'] = 'application/json'
    try:
        with http.open(Request(url, data=data, headers=headers), timeout=35) as response:
            if stream:
                return read_answer(response)
            raw = response.read(1024 * 1024 + 1)
            if len(raw) > 1024 * 1024:
                raise ValueError()
            if not raw:  # Successful revocation has an empty body.
                return {}
            result = json.loads(raw)
            if not isinstance(result, dict):
                raise ValueError()
            return result
    except HTTPError as error:
        with error:
            try:
                value = json.loads(error.read(8192)).get('error')
                code = value.get('code') if isinstance(value, dict) else value
            except (ValueError, AttributeError):
                code = None
        raise remote_error(error.code, code) from None
    except (OSError, HTTPException, ValueError, EOFError) as error:
        raise AIError(502, 'OpenAI 연결이 중단됐어요. 다시 시도해 주세요.') from error


def read_answer(response):
    deadline, size = time.monotonic() + 38, 0
    for raw in iter(lambda: response.readline(2 * 1024 * 1024), b''):
        size += len(raw)
        if size > 4 * 1024 * 1024 or time.monotonic() > deadline:
            break
        if not raw.startswith(b'data:'):
            continue
        data = raw[5:].strip()
        if data == b'[DONE]':
            break
        event = json.loads(data)
        if not isinstance(event, dict):
            break
        kind = event.get('type')
        result = event.get('response') or {}
        if kind in ('response.failed', 'error'):
            raise remote_error(0, (result.get('error') or event).get('code'))
        if kind == 'response.incomplete':
            break
        if kind == 'response.completed':
            parts = [part.get('text') or part.get('refusal') for item in result.get('output', [])
                     if item.get('type') == 'message' for part in item.get('content', [])
                     if part.get('type') in ('output_text', 'refusal')]
            answer = reply('\n'.join(p for p in parts if isinstance(p, str)))
            if answer:
                return answer
            break
    raise AIError(502, 'ChatGPT 답변이 끝까지 도착하지 않았어요. 다시 시도해 주세요.')


def session_key(token):
    return hashlib.sha256(token.encode()).hexdigest()


def profile(db, key):
    row = db.execute('SELECT profile FROM chatgpt_sessions WHERE session=?', (key,)).fetchone()
    return json.loads(row[0]) if row else {}


def save(store, token, grant):
    with store.lock, store.connect() as db:
        store.user(db, token)  # The session may have ended while OpenAI was responding.
        db.execute('INSERT OR REPLACE INTO chatgpt_sessions VALUES(?,?)', (session_key(token), json.dumps(grant)))


def valid_client(value):
    return isinstance(value, str) and bool(re.fullmatch(r'oaiapp_[A-Za-z0-9_-]{1,250}', value))


class ChatGPTPlan:
    @classmethod
    def load(cls, directory, local_port=None):
        if local_port is not None:
            origin = f'http://127.0.0.1:{local_port}'
            path = directory / 'chatgpt-host-id'
            if not path.exists():
                with path.open('x') as f:
                    path.chmod(0o600)
                    f.write(str(uuid.uuid4()))
            host = 'urn:uuid:' + str(uuid.UUID(path.read_text().strip()))
            return cls(origin + LOCAL_CALLBACK, origin + '/', host=host)
        filename = directory / 'chatgpt-web-client.json'
        if not filename.exists():
            return None
        config = private_json(filename) or {}
        redirect, frontend = config.get('redirect_uri', ''), config.get('frontend_url', '')
        for url in (redirect, frontend):
            parts = urlsplit(url)
            if parts.scheme != 'https' or not parts.hostname or parts.username or parts.password or parts.query or parts.fragment:
                raise ValueError('ChatGPT 웹 설정의 HTTPS 주소와 파일 권한(0600)을 확인해 주세요.')
        if (urlsplit(redirect).path != CALLBACK or not valid_client(config.get('client_id'))
                or ('client_secret' in config and not isinstance(config['client_secret'], str))):
            raise ValueError('OpenAI가 승인한 웹 클라이언트와 콜백 주소를 확인해 주세요.')
        return cls(redirect, frontend, client=config['client_id'], secret=config.get('client_secret'))

    def __init__(self, redirect, frontend, *, host=None, client=None, secret=None):
        try:
            import jwt
            from jwt.algorithms import RSAAlgorithm  # Requires the optional crypto extra.
        except ImportError as error:
            raise ValueError('ChatGPT 연결에는 PyJWT[crypto]가 필요합니다. README의 설치 방법을 확인해 주세요.') from error
        self.jwt = jwt
        self.keys = jwt.PyJWKClient(ISSUER + '/.well-known/jwks.json', timeout=10)
        self.redirect, self.frontend = redirect, frontend
        self.host, self.client, self.secret = host, client, secret
        self.states, self.callbacks = Pending(600), Pending(120)
        # Serialize credential replacement and rotating refreshes for the same session.
        self.locks = [threading.Lock() for _ in range(32)]

    def lock(self, token):
        return self.locks[int(session_key(token)[:2], 16) % len(self.locks)]

    def start(self, token, current):
        verifier, nonce = secrets.token_urlsafe(48), secrets.token_urlsafe(24)
        client = self.client or current.get('client_id')
        state = self.states.add(dict(owner=session_key(token), verifier=verifier, nonce=nonce,
                                     client=client, subject=current.get('subject'), previous=current.get('link_id')))
        args = dict(client_id=client or 'dynamic_agent_client', redirect_uri=self.redirect,
                    response_type='code', scope=SCOPES, resource=RESOURCE, state=state, nonce=nonce,
                    code_challenge_method='S256', code_challenge=base64.urlsafe_b64encode(
                        hashlib.sha256(verifier.encode()).digest()).decode().rstrip('='))
        if self.host:
            args['ext_agent_host_id'] = self.host
            if not client:
                args['agent_name_hint'] = 'Somhouse'
        return {'url': ACCOUNTS + '/authorize?' + urlencode(args)}

    def callback(self, query):
        try:
            args = parse_qs(query, max_num_fields=20)
        except ValueError:
            return self.frontend + '#chatgpt-error=registration'

        def one(key):
            values = args.get(key, [])
            return values[0] if len(values) == 1 else None
        pending = self.states.take(one('state'))
        if pending is None:
            return self.frontend + '#chatgpt-error=expired'
        if 'error' in args or not one('code'):
            return self.frontend + '#chatgpt-error=cancelled'
        client = one('client_id') or pending['client']
        if not valid_client(client) or (pending['client'] and client != pending['client']):
            return self.frontend + '#chatgpt-error=registration'
        # Only a short-lived receipt goes to the browser. Redeeming it requires the original login.
        receipt = self.callbacks.add(dict(pending, client=client, code=one('code')))
        return self.frontend + '#chatgpt=' + receipt

    def oauth(self, endpoint, fields):
        headers = {}
        if self.secret:
            basic = quote_plus(self.client) + ':' + quote_plus(self.secret)
            headers['Authorization'] = 'Basic ' + base64.b64encode(basic.encode()).decode()
        return request(ACCOUNTS + '/oauth/' + endpoint, fields=fields, headers=headers)

    def identity(self, token, pending):
        try:
            key = self.keys.get_signing_key_from_jwt(token)
            claims = self.jwt.decode(token, key.key, algorithms=['RS256'], audience=pending['client'], issuer=ISSUER,
                                     leeway=5, options={'require': ['sub', 'iat', 'exp', 'nonce']})
            if (not claims['sub'] or claims['nonce'] != pending['nonce']
                    or claims.get('azp', pending['client']) != pending['client'] or
                    pending['subject'] and pending['subject'] != claims['sub']):
                raise ValueError()
            return claims
        except (self.jwt.PyJWTError, ValueError, TypeError) as error:
            raise AIError(403, 'ChatGPT 계정을 확인하지 못했어요. 다시 연결해 주세요.') from error

    @staticmethod
    def credentials(tokens, existing=None):
        scopes = tokens.get('scope')
        if scopes is not None or existing is None:
            if not isinstance(scopes, str) or not {PERMISSION, 'resource.invoke'} <= set(scopes.split()):
                raise AIError(403, 'ChatGPT 플랜 사용 권한에 동의한 계정으로 연결해 주세요.')
        access, expiry = tokens.get('access_token'), tokens.get('expires_in')
        if (not isinstance(access, str) or not access or tokens.get('token_type', '').lower() != 'bearer'
                or not isinstance(expiry, (int, float)) or not 0 < expiry <= 86400 * 30):
            raise AIError(502, 'ChatGPT 사용 권한을 확인하지 못했어요. 다시 연결해 주세요.')
        return dict(existing or {}, access=access, expires=time.time()+expiry,
                    refresh=tokens.get('refresh_token') or (existing or {}).get('refresh'))

    def finish(self, store, token, receipt):
        pending = self.callbacks.take(receipt)
        if not pending or pending['owner'] != session_key(token):
            raise AIError(403, '연결을 시작한 솜하우스 로그인에서 다시 시도해 주세요.')
        with self.lock(token):
            with store.connect() as db:
                if profile(db, session_key(token)).get('link_id') != pending['previous']:
                    raise AIError(409, RECONNECT)
            client = pending['client']
            tokens = self.oauth('token', dict(grant_type='authorization_code', client_id=client,
                                code=pending['code'], code_verifier=pending['verifier'], redirect_uri=self.redirect, resource=RESOURCE))
            identity = self.identity(tokens.get('id_token'), pending)
            grant = self.credentials(tokens)
            catalog = request(RESOURCE + '/models', headers={'Authorization': 'Bearer ' + grant['access']})
            model = next((m.get('slug') for m in catalog.get('models', []) if isinstance(m, dict)
                          and m.get('visibility') == 'list' and isinstance(m.get('slug'), str) and m['slug']), None)
            if not model:
                raise AIError(403, '이 ChatGPT 계정에서 사용할 수 있는 구독 모델이 없어요.')
            grant.update(subject=identity['sub'], email=identity.get('email') if identity.get('email_verified') is True else '',
                         client_id=client, model=model, link_id=secrets.token_urlsafe(16))
            save(store, token, grant)
        return {'connected': True}

    def disconnect(self, store, token):
        with self.lock(token), store.connect() as db:
            key = session_key(token)
            grant = profile(db, key)
            db.execute('DELETE FROM chatgpt_sessions WHERE session=?', (key,))
        return {'connected': False, 'revoked': self.revoke(grant)}

    def revoke(self, grant):
        if grant.get('refresh'):
            try:
                self.oauth('revoke', dict(token=grant['refresh'], token_type_hint='refresh_token', client_id=grant['client_id']))
            except AIError:
                return False
        return True

    def ask(self, store, token, question):
        with self.lock(token):
            with store.connect() as db:
                grant = profile(db, session_key(token))
            if not grant:
                raise AIError(409, RECONNECT)
            if grant['expires'] < time.time() + 30:
                if not grant.get('refresh'):
                    raise AIError(409, RECONNECT)
                refreshed = self.oauth('token', dict(client_id=grant['client_id'], grant_type='refresh_token',
                                       refresh_token=grant['refresh'], resource=RESOURCE))
                grant = self.credentials(refreshed, grant)
                save(store, token, grant)
        return request(RESOURCE + '/responses', headers={'Authorization': 'Bearer ' + grant['access']},
                       payload=dict(model=grant['model'], instructions=SYSTEM, input=question,
                                    store=False, stream=True), stream=True)
