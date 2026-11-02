#!/usr/bin/env python3
# سرور داخلی کافه موزه + ذخیرهٔ خودکار قیمت‌ها
# اجرا:  python3 serve.py   (پورت پیش‌فرض 8080)
# صفحهٔ ویرایش:  http://IP:8080/price-editor.html
import json, os, sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
PRICES = 'prices.json'

class H(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_POST(self):
        if self.path.rstrip('/') == '/save-prices':
            try:
                n = int(self.headers.get('Content-Length', 0))
                data = json.loads(self.rfile.read(n).decode('utf-8'))
                assert isinstance(data, dict)
                tmp = PRICES + '.tmp'
                with open(tmp, 'w', encoding='utf-8') as f:
                    json.dump(data, f, ensure_ascii=False, indent=2)
                os.replace(tmp, PRICES)
                body = json.dumps({'ok': True}).encode()
                self.send_response(200)
            except Exception as e:
                body = json.dumps({'ok': False, 'error': str(e)}).encode()
                self.send_response(400)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_error(404)

    def log_message(self, fmt, *args):
        pass

if __name__ == '__main__':
    print(f'کافه موزه — سرور محلی: http://0.0.0.0:{PORT}  (ویرایش قیمت: /price-editor.html)')
    ThreadingHTTPServer(('0.0.0.0', PORT), H).serve_forever()
