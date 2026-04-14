/**
 * 数据库操作模块（测试 fixture）
 * 模拟一套简单的内存数据库接口。
 */

export interface Record {
  id: number;
  key: string;
  value: unknown;
  createdAt: Date;
}

/** 简单的内存 KV 存储，模拟数据库操作 */
export class InMemoryDB {
  private store = new Map<number, Record>();
  private nextId = 1;

  /** 插入一条记录 */
  insert(key: string, value: unknown): Record {
    const record: Record = {
      id: this.nextId++,
      key,
      value,
      createdAt: new Date(),
    };
    this.store.set(record.id, record);
    return record;
  }

  /** 按 id 查询 */
  findById(id: number): Record | undefined {
    return this.store.get(id);
  }

  /** 按 key 查询所有匹配记录 */
  findByKey(key: string): Record[] {
    return [...this.store.values()].filter(r => r.key === key);
  }

  /** 删除记录 */
  delete(id: number): boolean {
    return this.store.delete(id);
  }

  /** 全量列表 */
  list(): Record[] {
    return [...this.store.values()];
  }

  /** 清空 */
  clear(): void {
    this.store.clear();
    this.nextId = 1;
  }
}

/**
 * 连接字符串解析
 * 格式：sqlite:/path/to/db 或 memory://
 */
export function parseConnectionString(conn: string): { type: 'sqlite' | 'memory'; path?: string } {
  if (conn.startsWith('memory://')) {
    return { type: 'memory' };
  }
  if (conn.startsWith('sqlite:')) {
    return { type: 'sqlite', path: conn.slice('sqlite:'.length) };
  }
  throw new Error(`不支持的连接字符串格式：${conn}`);
}
