#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""离线书帖结构复原台 —— 本地服务

仅依赖 Python 标准库（http.server / sqlite3 / json）。
启动后默认监听 http://127.0.0.1:8371

数据保存在工作目录下的 restoration.db（SQLite），
所有假设（复原方案）以 JSON 文档形式整存整取。
"""

import json
import os
import re
import sqlite3
import sys
import threading
import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

HOST = "127.0.0.1"
PORT = 8371
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
DB_PATH = os.path.join(BASE_DIR, "restoration.db")

_write_lock = threading.Lock()


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with get_db() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS hypotheses (
                id          TEXT PRIMARY KEY,
                name        TEXT NOT NULL,
                data        TEXT NOT NULL,
                updated_at  TEXT NOT NULL
            )
            """
        )


def now_iso():
    return datetime.datetime.now().isoformat(timespec="seconds")


# ---------------------------------------------------------------- HTTP handler

API_PREFIX = "/api/hypotheses"
ID_RE = re.compile(r"^/api/hypotheses/([A-Za-z0-9_-]+)/?$")


class Handler(BaseHTTPRequestHandler):
    server_version = "QuireRestoration/1.0"

    # ---- 基础工具 ----
    def _send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_static(self, rel_path):
        # 防路径穿越
        safe = os.path.normpath(os.path.join(STATIC_DIR, rel_path))
        if not safe.startswith(STATIC_DIR + os.sep) and safe != STATIC_DIR:
            self.send_error(403)
            return
        if os.path.isdir(safe):
            safe = os.path.join(safe, "index.html")
        if not os.path.isfile(safe):
            self.send_error(404)
            return
        ctype = {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".svg": "image/svg+xml",
            ".json": "application/json; charset=utf-8",
            ".png": "image/png",
            ".ico": "image/x-icon",
        }.get(os.path.splitext(safe)[1], "application/octet-stream")
        try:
            with open(safe, "rb") as f:
                body = f.read()
        except OSError:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            self._send_json({"error": "请求体不是合法的 JSON"}, 400)
            return None

    # ---- 路由 ----
    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/" or path == "":
            self._send_static("index.html")
            return
        if path == API_PREFIX or path == API_PREFIX + "/":
            self._list_hypotheses()
            return
        m = ID_RE.match(path)
        if m:
            self._get_hypothesis(m.group(1))
            return
        if path.startswith("/static/"):
            self._send_static(path[len("/static/"):])
            return
        # 友好兜底：未知非 API 路径返回首页（便于直接刷新）
        if not path.startswith("/api/"):
            self._send_static("index.html")
            return
        self.send_error(404)

    def do_POST(self):
        path = urlparse(self.path).path
        if path == API_PREFIX or path == API_PREFIX + "/":
            payload = self._read_json()
            if payload is None:
                return
            self._create_hypothesis(payload)
            return
        self.send_error(404)

    def do_PUT(self):
        m = ID_RE.match(urlparse(self.path).path)
        if not m:
            self.send_error(404)
            return
        payload = self._read_json()
        if payload is None:
            return
        self._update_hypothesis(m.group(1), payload)

    def do_DELETE(self):
        m = ID_RE.match(urlparse(self.path).path)
        if not m:
            self.send_error(404)
            return
        self._delete_hypothesis(m.group(1))

    # ---- CRUD ----
    def _list_hypotheses(self):
        with get_db() as conn:
            rows = conn.execute(
                "SELECT id, name, updated_at FROM hypotheses ORDER BY updated_at DESC"
            ).fetchall()
        self._send_json(
            {
                "hypotheses": [
                    {"id": r["id"], "name": r["name"], "updated_at": r["updated_at"]}
                    for r in rows
                ]
            }
        )

    def _get_hypothesis(self, hid):
        with get_db() as conn:
            row = conn.execute(
                "SELECT id, name, data, updated_at FROM hypotheses WHERE id = ?",
                (hid,),
            ).fetchone()
        if row is None:
            self._send_json({"error": "假设不存在"}, 404)
            return
        try:
            data = json.loads(row["data"])
        except json.JSONDecodeError:
            data = {}
        self._send_json(
            {"id": row["id"], "name": row["name"], "data": data,
             "updated_at": row["updated_at"]}
        )

    def _create_hypothesis(self, payload):
        hid = str(payload.get("id") or new_id())
        name = str(payload.get("name") or "未命名假设")
        data = payload.get("data")
        if data is None:
            data = new_document()
        # 服务端做一次最低限度的结构补齐
        data = normalize_document(data)
        ts = now_iso()
        with _write_lock, get_db() as conn:
            try:
                conn.execute(
                    "INSERT INTO hypotheses (id, name, data, updated_at) VALUES (?,?,?,?)",
                    (hid, name, json.dumps(data, ensure_ascii=False), ts),
                )
            except sqlite3.IntegrityError:
                self._send_json({"error": "同名/同 ID 假设已存在"}, 409)
                return
        self._send_json({"id": hid, "name": name, "data": data, "updated_at": ts}, 201)

    def _update_hypothesis(self, hid, payload):
        name = payload.get("name")
        data = payload.get("data")
        if data is None:
            self._send_json({"error": "缺少 data 字段"}, 400)
            return
        data = normalize_document(data)
        name = str(name or "未命名假设")
        ts = now_iso()
        with _write_lock, get_db() as conn:
            cur = conn.execute(
                "UPDATE hypotheses SET name = ?, data = ?, updated_at = ? WHERE id = ?",
                (name, json.dumps(data, ensure_ascii=False), ts, hid),
            )
            if cur.rowcount == 0:
                self.send_error(404)
                return
        self._send_json({"id": hid, "name": name, "data": data, "updated_at": ts})

    def _delete_hypothesis(self, hid):
        with _write_lock, get_db() as conn:
            cur = conn.execute("DELETE FROM hypotheses WHERE id = ?", (hid,))
        if cur.rowcount == 0:
            self.send_error(404)
            return
        self._send_json({"deleted": hid})

    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))


# ---------------------------------------------------------------- 文档结构

def new_id():
    import uuid
    return uuid.uuid4().hex[:12]


def new_document():
    """空白复原文档（服务器端兜底；正常情况下由前端构造）。"""
    return {
        "version": 1,
        "title": "未命名卷子",
        "leaves": [],
        "pairs": [],
        "quires": [],
        "evidences": [],
        "claims": [],
        "links": [],
        "notes": "",
    }


def normalize_document(data):
    """对导入/保存的文档做基本字段补齐，避免老数据或缺字段数据导致前端崩溃。"""
    if not isinstance(data, dict):
        data = {}
    data.setdefault("version", 1)
    data.setdefault("title", "未命名卷子")
    data.setdefault("leaves", [])
    data.setdefault("pairs", [])
    data.setdefault("quires", [])
    data.setdefault("evidences", [])
    data.setdefault("claims", [])
    data.setdefault("links", [])
    data.setdefault("notes", "")
    for key in ("leaves", "pairs", "quires", "evidences", "claims", "links"):
        if not isinstance(data[key], list):
            data[key] = []
    for lf in data["leaves"]:
        if isinstance(lf, dict):
            lf.setdefault("folio", "")
            lf.setdefault("status", "doubt")
            lf.setdefault("frag", False)
            lf.setdefault("evidence", {})
    for pr in data["pairs"]:
        if isinstance(pr, dict):
            pr.setdefault("status", "doubt")
            pr.setdefault("evidence", {})
    for q in data["quires"]:
        if isinstance(q, dict):
            q.setdefault("locked", False)
            q.setdefault("leaves", [])
    for ev in data["evidences"]:
        if isinstance(ev, dict):
            ev.setdefault("subjects", [])
            ev.setdefault("status", "pending")
            ev.setdefault("credibility", "medium")
            ev.setdefault("source", "")
            ev.setdefault("basis", [])
            ev.setdefault("archived", False)
            ev.setdefault("mergedInto", None)
            ev.setdefault("history", [])
    for cl in data["claims"]:
        if isinstance(cl, dict):
            cl.setdefault("kind", "note")
            cl.setdefault("label", "")
            cl.setdefault("note", "")
            cl.setdefault("created_at", now_iso())
    for lk in data["links"]:
        if isinstance(lk, dict):
            lk.setdefault("stance", "support")
            lk.setdefault("created_at", now_iso())
    return data


def main():
    init_db()
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    url = "http://%s:%d/" % (HOST, PORT)
    print("书帖结构复原台已启动：%s" % url)
    print("数据文件：%s" % DB_PATH)
    print("按 Ctrl+C 停止服务。")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n正在停止…")
        httpd.server_close()


if __name__ == "__main__":
    main()
