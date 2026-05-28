const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@libsql/client');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

// --- 各種設定（環境に合わせて書き換えてください） ---
const GAS_WEBAPP_URL = process.env.GAS_WEBAPP_URL || "https://script.google.com/macros/s/AKfycbwYsl3issVM1SgFyeuRVCITmIfex6kc7lmuiRXVpxbD195ctM0aAsyUxBV_NZxVz9UH/exec";
const db = createClient({
    url: process.env.TURSO_DATABASE_URL || "libsql://senninchat-senninch.aws-ap-northeast-1.turso.io",
    authToken: process.env.TURSO_AUTH_TOKEN || "YOUR_TURSO_AUTH_TOKEN" // 安全のためプレースホルダーに変更しています
});

// データベースの初期化
async function initDB() {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS users (
            user_id TEXT PRIMARY KEY,
            username TEXT NOT NULL UNIQUE
        )
    `);
    await db.execute(`
        CREATE TABLE IF NOT EXISTS friends (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            friend_id TEXT NOT NULL,
            UNIQUE(user_id, friend_id)
        )
    `);
    // 拡張：is_deleted (送信取り消しフラグ) を追加。ALTER TABLEは既存環境への配慮
    await db.execute(`
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            channel TEXT NOT NULL,
            name TEXT NOT NULL,
            avatar TEXT NOT NULL,
            color TEXT NOT NULL,
            text TEXT NOT NULL,
            timestamp TEXT NOT NULL,
            is_deleted INTEGER DEFAULT 0
        )
    `);
    try {
        await db.execute(`ALTER TABLE messages ADD COLUMN is_deleted INTEGER DEFAULT 0`);
    } catch (e) {
        // すでにカラムが存在する場合は無視
    }

    // 新設：既読管理テーブル（メッセージIDごと、ユーザーごとの既読）
    await db.execute(`
        CREATE TABLE IF NOT EXISTS message_reads (
            message_id INTEGER NOT NULL,
            user_id TEXT NOT NULL,
            PRIMARY KEY(message_id, user_id)
        )
    `);

    // 新設：グループ管理テーブル
    await db.execute(`
        CREATE TABLE IF NOT EXISTS groups (
            group_id TEXT PRIMARY KEY,
            group_name TEXT NOT NULL
        )
    `);

    // 新設：グループメンバー管理テーブル
    await db.execute(`
        CREATE TABLE IF NOT EXISTS group_members (
            group_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            PRIMARY KEY(group_id, user_id)
        )
    `);
}
initDB().catch(console.error);

// --- アカウントサービスAPI (GAS連携) ---

// 1. ログイン処理
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const fetch = (await import('node-fetch')).default;
        const gasRes = await fetch(`${GAS_WEBAPP_URL}?action=login&username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`, {
            method: 'POST'
        });
        const result = await gasRes.json();

        if (result.success) {
            // 認証成功時、Turso側にユーザー情報を同期保存（存在しなければ挿入）
            await db.execute({
                sql: "INSERT OR IGNORE INTO users (user_id, username) VALUES (?, ?)",
                args: [result.userId, result.username]
            });
        }
        res.json(result);
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// 2. 新規登録処理
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    try {
        const fetch = (await import('node-fetch')).default;
        const gasRes = await fetch(`${GAS_WEBAPP_URL}?action=register&username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`, {
            method: 'POST'
        });
        const result = await gasRes.json();

        if (result.success) {
            // 登録成功時、Turso側にユーザー情報を同期保存
            await db.execute({
                sql: "INSERT OR IGNORE INTO users (user_id, username) VALUES (?, ?)",
                args: [result.userId, result.username]
            });
        }
        res.json(result);
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// 3. フレンド追加処理 (userId を使用 - お互いに登録されるように修正)
app.post('/api/friends/add', async (req, res) => {
    const { userId, friendId } = req.body;
    if (!userId || !friendId) {
        return res.json({ success: false, message: "ユーザーIDまたはフレンドIDが不足しています。" });
    }
    if (userId === friendId) {
        return res.json({ success: false, message: "自分自身をフレンドに追加することはできません。" });
    }
    try {
        // 追加対象のフレンドがTursoのユーザーリストに存在するかチェック
        const userCheck = await db.execute({
            sql: "SELECT username FROM users WHERE user_id = ?",
            args: [friendId]
        });
        if (userCheck.rows.length === 0) {
            return res.json({ success: false, message: "該当する固有IDのユーザーがチャットシステムに見つかりません。" });
        }

        // 自分から相手へのフレンド関係を保存
        await db.execute({
            sql: "INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?, ?)",
            args: [userId, friendId]
        });

        // 相手から自分へのフレンド関係も同時に保存（お互いにフレンド化）
        await db.execute({
            sql: "INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?, ?)",
            args: [friendId, userId]
        });

        res.json({ success: true, message: `フレンド「${userCheck.rows[0].username}」とお互いにフレンドになりました。` });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// 4. フレンド一覧取得処理
app.get('/api/friends', async (req, res) => {
    const { userId } = req.query;
    try {
        const result = await db.execute({
            sql: "SELECT u.user_id, u.username FROM friends f JOIN users u ON f.friend_id = u.user_id WHERE f.user_id = ?",
            args: [userId]
        });
        res.json({ success: true, friends: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// 新設 5. グループ作成処理
app.post('/api/groups/create', async (req, res) => {
    const { groupName, creatorId, memberIds } = req.body; // memberIdsは配列形式
    if (!groupName || !creatorId) {
        return res.json({ success: false, message: "グループ名または作成者IDが不足しています。" });
    }
    try {
        const groupId = "group_" + Date.now() + "_" + Math.random().toString(36).substring(2, 7);
        
        // グループ自体の登録
        await db.execute({
            sql: "INSERT INTO groups (group_id, group_name) VALUES (?, ?)",
            args: [groupId, groupName]
        });

        // 作成者をメンバーに追加
        await db.execute({
            sql: "INSERT INTO group_members (group_id, user_id) VALUES (?, ?)",
            args: [groupId, creatorId]
        });

        // 選択されたフレンドをメンバーに追加
        if (Array.isArray(memberIds)) {
            for (const mId of memberIds) {
                if (mId !== creatorId) {
                    await db.execute({
                        sql: "INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)",
                        args: [groupId, mId]
                    });
                }
            }
        }

        res.json({ success: true, message: `グループ「${groupName}」を作成しました。`, groupId: groupId });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// 新設 6. 所属グループ一覧取得処理
app.get('/api/groups', async (req, res) => {
    const { userId } = req.query;
    try {
        const result = await db.execute({
            sql: "SELECT g.group_id, g.group_name FROM group_members gm JOIN groups g ON gm.group_id = g.group_id WHERE gm.user_id = ?",
            args: [userId]
        });
        res.json({ success: true, groups: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});


// --- Socket.io リアルタイム通信ロジック ---
io.on('connection', (socket) => {
    
    // チャンネル（ルーム）入室処理
    socket.on('join_channel', async (data) => {
        const { myId, friendId, isGroup, groupId } = data;
        let roomId = '';

        if (isGroup) {
            roomId = groupId;
        } else {
            if (!myId || !friendId) return;
            roomId = [myId, friendId].sort().join('_');
        }
        
        socket.join(roomId);

        try {
            // メッセージ履歴の取得（既読数カウント付き）
            const result = await db.execute({
                sql: `SELECT m.*, 
                      (SELECT COUNT(*) FROM message_reads mr WHERE mr.message_id = m.id) as read_count 
                      FROM messages m WHERE m.channel = ? ORDER BY m.id ASC LIMIT 100`,
                args: [roomId]
            });

            // 入室した瞬間に、その部屋の他人のメッセージをすべて「既読」にする処理
            const unreadMessages = result.rows.filter(row => row.name !== data.myUsername && row.is_deleted !== 1);
            for (const msg of unreadMessages) {
                await db.execute({
                    sql: "INSERT OR IGNORE INTO message_reads (message_id, user_id) VALUES (?, ?)",
                    args: [msg.id, myId]
                });
            }

            // 既読状態が更新されたため、再度最新の履歴を取得してクライアントに送る
            const updatedResult = await db.execute({
                sql: `SELECT m.*, 
                      (SELECT COUNT(*) FROM message_reads mr WHERE mr.message_id = m.id) as read_count 
                      FROM messages m WHERE m.channel = ? ORDER BY m.id ASC LIMIT 100`,
                args: [roomId]
            });

            socket.emit('load_history', updatedResult.rows);

            // 部屋の他のユーザーに既読状況が更新されたことを通知
            io.to(roomId).emit('messages_read_updated', { channel: roomId });

        } catch (err) {
            console.error("データ取得失敗:", err);
        }
    });

    // メッセージ送信処理
    socket.on('send_message', async (msgData) => {
        const { myId, friendId, isGroup, groupId, name, avatar, color, text, timestamp } = msgData;
        let roomId = '';

        if (isGroup) {
            roomId = groupId;
        } else {
            if (!myId || !friendId) return;
            roomId = [myId, friendId].sort().join('_');
        }

        try {
            const insertRes = await db.execute({
                sql: "INSERT INTO messages (channel, name, avatar, color, text, timestamp, is_deleted) VALUES (?, ?, ?, ?, ?, ?, 0)",
                args: [roomId, name, avatar, color, text, timestamp]
            });
            
            // SQLite/libsql の直近挿入IDを取得
            const messageId = Number(insertRes.lastInsertRowid);

            // 送信者自身は最初から既読扱いにする
            await db.execute({
                sql: "INSERT OR IGNORE INTO message_reads (message_id, user_id) VALUES (?, ?)",
                args: [messageId, myId]
            });

            io.to(roomId).emit('receive_message', {
                id: messageId,
                channel: roomId,
                name: name,
                avatar: avatar,
                color: color,
                text: text,
                timestamp: timestamp,
                is_deleted: 0,
                read_count: 1
            });
        } catch (err) {
            console.error("データ保存失敗:", err);
        }
    });

    // 拡張：メッセージ送信取り消し処理
    socket.on('unsend_message', async (data) => {
        const { messageId, roomId } = data;
        try {
            await db.execute({
                sql: "UPDATE messages SET is_deleted = 1, text = 'メッセージの送信を取り消しました' WHERE id = ?",
                args: [messageId]
            });
            io.to(roomId).emit('message_unsent', { messageId: messageId, roomId: roomId });
        } catch (err) {
            console.error("送信取り消し失敗:", err);
        }
    });

    // 拡張：リアルタイム既読更新処理
    socket.on('mark_as_read', async (data) => {
        const { roomId, myId } = data;
        try {
            const result = await db.execute({
                sql: "SELECT id FROM messages WHERE channel = ? AND is_deleted = 0",
                args: [roomId]
            });
            for (const row of result.rows) {
                await db.execute({
                    sql: "INSERT OR IGNORE INTO message_reads (message_id, user_id) VALUES (?, ?)",
                    args: [row.id, myId]
                });
            }
            io.to(roomId).emit('messages_read_updated', { channel: roomId });
        } catch (err) {
            console.error("既読更新失敗:", err);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
