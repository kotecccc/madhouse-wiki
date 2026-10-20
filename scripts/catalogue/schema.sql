PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sources (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL, locator TEXT NOT NULL,
 verification TEXT NOT NULL, note TEXT, fetched_at TEXT
);
CREATE TABLE IF NOT EXISTS entities (
 kind TEXT NOT NULL, id TEXT NOT NULL, api_id TEXT, name TEXT,
 source_id TEXT NOT NULL REFERENCES sources(id),
 data_json TEXT NOT NULL CHECK(json_valid(data_json)),
 updated_at TEXT NOT NULL, PRIMARY KEY(kind,id)
);
CREATE INDEX IF NOT EXISTS entities_api_id ON entities(kind,api_id);
CREATE TABLE IF NOT EXISTS entity_links (
 from_kind TEXT NOT NULL, from_id TEXT NOT NULL, relation TEXT NOT NULL,
 to_kind TEXT NOT NULL, to_id TEXT NOT NULL, ordinal INTEGER NOT NULL DEFAULT 0,
 source_id TEXT NOT NULL REFERENCES sources(id),
 FOREIGN KEY(from_kind,from_id) REFERENCES entities(kind,id),
 PRIMARY KEY(from_kind,from_id,relation,to_kind,to_id)
);
CREATE TABLE IF NOT EXISTS api_operations (
 method TEXT NOT NULL CHECK(method='GET'), path TEXT NOT NULL,
 summary_ru TEXT NOT NULL, purpose TEXT NOT NULL,
 response_schema_json TEXT NOT NULL CHECK(json_valid(response_schema_json)),
 PRIMARY KEY(method,path)
);
CREATE TABLE IF NOT EXISTS captures (
 path TEXT PRIMARY KEY, status INTEGER NOT NULL, entity_count INTEGER NOT NULL,
 captured_at TEXT NOT NULL, note TEXT
);
CREATE VIEW IF NOT EXISTS floors AS SELECT id,api_id,json_extract(data_json,'$.code') code,name,data_json,source_id FROM entities WHERE kind='floor';
CREATE VIEW IF NOT EXISTS departments AS SELECT id,api_id,json_extract(data_json,'$.floorId') floor_id,coalesce(json_extract(data_json,'$.code'),json_extract(data_json,'$.blockCode')) code,name,data_json,source_id FROM entities WHERE kind='department';
CREATE VIEW IF NOT EXISTS works AS SELECT id,api_id,json_extract(data_json,'$.departmentId') department_id,name,data_json,source_id FROM entities WHERE kind='work';
CREATE VIEW IF NOT EXISTS businesses AS SELECT id,api_id,json_extract(data_json,'$.departmentId') department_id,name,data_json,source_id FROM entities WHERE kind='business';
CREATE VIEW IF NOT EXISTS business_upgrades AS SELECT id,name,data_json,source_id FROM entities WHERE kind='business_upgrade';
CREATE VIEW IF NOT EXISTS bosses AS SELECT id,api_id,json_extract(data_json,'$.departmentId') department_id,name,json_extract(data_json,'$.requiredLevel') required_level,coalesce(json_extract(data_json,'$.maxHp'),json_extract(data_json,'$.maxHp')) max_hp,data_json,source_id FROM entities WHERE kind='boss';
CREATE VIEW IF NOT EXISTS requirements AS SELECT id,name,data_json,source_id FROM entities WHERE kind='requirement';
CREATE VIEW IF NOT EXISTS clothing_items AS SELECT id,api_id,name,data_json,source_id FROM entities WHERE kind='clothing_item';
CREATE VIEW IF NOT EXISTS clothing_sets AS SELECT id,api_id,name,data_json,source_id FROM entities WHERE kind='clothing_set';
CREATE VIEW IF NOT EXISTS weapons AS SELECT id,api_id,name,data_json,source_id FROM entities WHERE kind='weapon';
CREATE VIEW IF NOT EXISTS pets AS SELECT id,api_id,name,data_json,source_id FROM entities WHERE kind='pet';
CREATE VIEW IF NOT EXISTS rooms AS SELECT id,api_id,name,data_json,source_id FROM entities WHERE kind='room';
CREATE VIEW IF NOT EXISTS stash_sets AS SELECT id,api_id,name,data_json,source_id FROM entities WHERE kind='stash_set';
CREATE VIEW IF NOT EXISTS stash_ingredients AS SELECT id,api_id,name,data_json,source_id FROM entities WHERE kind='stash_ingredient';
CREATE VIEW IF NOT EXISTS achievements AS SELECT id,api_id,name,data_json,source_id FROM entities WHERE kind='achievement';
CREATE VIEW IF NOT EXISTS mutagens AS SELECT id,api_id,name,data_json,source_id FROM entities WHERE kind='mutagen';
CREATE VIEW IF NOT EXISTS recipes AS SELECT kind,id,api_id,name,data_json,source_id FROM entities WHERE kind IN ('mutagen_recipe','mutagen_exchange_recipe');
CREATE VIEW IF NOT EXISTS ornament_sets AS SELECT id,api_id,name,data_json,source_id FROM entities WHERE kind='ornament_set';
CREATE VIEW IF NOT EXISTS ornament_elements AS SELECT id,api_id,name,data_json,source_id FROM entities WHERE kind='ornament_element';
CREATE VIEW IF NOT EXISTS quest_definitions AS SELECT id,api_id,name,data_json,source_id FROM entities WHERE kind='quest';
CREATE VIEW IF NOT EXISTS unresolved_links AS SELECT l.* FROM entity_links l LEFT JOIN entities e ON e.kind=l.to_kind AND e.id=l.to_id WHERE e.id IS NULL;
