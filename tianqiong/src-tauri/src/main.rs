use tauri_plugin_sql::{Builder, Migration, MigrationKind};

/// 存档迁移（§4 数据契约：第一阶段整包 JSON 落库，热数据后续拆表）
fn migrations() -> Vec<Migration> {
    vec![Migration {
        version: 1,
        description: "init_saves",
        kind: MigrationKind::Up,
        sql: "CREATE TABLE IF NOT EXISTS saves (
                id TEXT PRIMARY KEY,
                ver INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                payload TEXT NOT NULL
              );",
    }]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
fn main() {
    tauri::Builder::default()
        .plugin(
            Builder::default()
                .add_migrations("sqlite:tianqiong.db", migrations())
                .build(),
        )
        .run(tauri::generate_context!())
        .expect("天穹纪元 2.0 启动失败");
}
