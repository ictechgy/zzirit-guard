import BetterSqlite3 from "better-sqlite3";
import { runMigrations } from "./migrations.js";

/** 서버가 쓰는 SQLite 연결 타입. */
export type Database = BetterSqlite3.Database;

/**
 * SQLite 파일을 열고 운영 설정과 마이그레이션을 적용한다.
 * WAL은 읽기와 쓰기가 서로 막지 않게 하려고, foreign_keys는 채널 해제 시 토큰(credential) 행을 지우려고 켠다.
 * secure_delete는 지운 행 자리를 0으로 덮어, 보관 기한이 지나 지운 채팅 원문이 DB 파일의 빈 페이지에 남지 않게 한다(개인정보 파기, F5).
 * @param filePath DB 파일 경로. 테스트에서는 ":memory:"
 */
export function openDatabase(filePath: string): Database {
  const database = new BetterSqlite3(filePath);
  database.pragma("secure_delete = ON");
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  runMigrations(database);
  return database;
}
