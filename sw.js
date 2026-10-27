// 홈 화면 설치용 최소 서비스워커 — 화면·데이터를 저장(캐시)하지 않음.
// 항상 최신 내용을 서버에서 받아오므로 배포 후 옛 화면이 남는 일이 없습니다.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* 네트워크 그대로 사용 */ });
