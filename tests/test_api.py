from fastapi.testclient import TestClient

from app import app

client = TestClient(app)


def test_health_is_available_without_oauth_credentials():
    response = client.get('/health')
    assert response.status_code == 200
    assert response.json()['status'] == 'ok'


def test_auth_status_does_not_claim_a_channel_is_connected():
    response = client.get('/api/auth/status')
    assert response.status_code == 200
    assert response.json()['connected'] is False


def test_channel_data_requires_a_session():
    response = client.get('/api/channel')
    assert response.status_code == 401
    assert response.json()['detail']['code'] == 'AUTH_REQUIRED'


def test_upload_jobs_require_a_session():
    response = client.get('/api/upload-jobs')
    assert response.status_code == 401


def test_comments_require_a_session():
    response = client.get('/api/comments', params={'video_id': 'abc123'})
    assert response.status_code == 401
