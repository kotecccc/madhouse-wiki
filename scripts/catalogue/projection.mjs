// Strict reference-field allowlists. Unknown fields and account state are discarded.
const scalar = true;
const stats = { madness: scalar, aggression: scalar, rage: scalar, endurance: scalar, maxHealth: scalar, baseDamage: scalar, critChance: scalar };
const money = { gold: scalar, dollar: scalar, pills: scalar, exp: scalar };
const price = { currency: scalar, amount: scalar, gold: scalar, dollar: scalar, pills: scalar, stars: scalar };
const unlock = { required: scalar, conditionType: scalar, conditionId: scalar, requiredLevel: scalar };
export const identity = { id: scalar, key: scalar, name: scalar, title: scalar, description: scalar, nameKey: scalar, titleKey: scalar, nameRu: scalar, nameEn: scalar, image: scalar, imageUrl: scalar, previewImageUrl: scalar, previewUrl: scalar, icon: scalar, iconUrl: scalar, asset: scalar, logo: scalar, sourceFloor: scalar, sortOrder: scalar, cdnBaseUrl: scalar };
const requirement = { type: scalar, label: scalar, required: scalar, requiredLevel: scalar, workId: scalar, bossId: scalar, businessId: scalar, medallionId: scalar, targetDepartmentId: scalar, targetBossId: scalar, targetBusinessId: scalar, sourceId: scalar, observedAt: scalar, verification: scalar };
const rewards = { exp: scalar, wallet: money, effects: [{ stat: scalar, amount: scalar }], effectsDurationSeconds: scalar, gold: scalar, dollar: scalar, pills: scalar };
export const projections = {
 floor: { number: scalar, code: scalar, requiredLevel: scalar, unlockDescription: scalar, unlockRequirements: [requirement], note: scalar, openingConditionText: scalar, unlock: scalar, openingConditionSourceId: scalar },
 department: { ...identity, code: scalar, blockCode: scalar, floorId: scalar, nameSourceId: scalar, requirements: [requirement] },
 work: { ...identity, departmentId: scalar, stash: scalar, sourceRecordId: scalar, sourceId: scalar, energyCycle: { full: scalar, state: scalar, detail: scalar, sourceId: scalar } },
 business: { ...identity, departmentId: scalar, maxLevel: scalar, currency: scalar },
 business_upgrade: { ...identity, departmentId: scalar, businessId: scalar, source: scalar, sourceId: scalar, note: scalar, items: [{ name: scalar, levels: [scalar] }] },
 boss: { ...identity, numericId: scalar, departmentId: scalar, dropItemId: scalar, requiredLevel: scalar, maxHp: scalar, damageMin: scalar, damageMax: scalar, rewardUntilLevel: scalar, maxFightDurationSeconds: scalar, maxParticipants: scalar, surrenderDollarCost: scalar, possibleDrops: [{ ...identity, itemId: scalar, type: scalar, kind: scalar, mode: scalar, categoryId: scalar, setId: scalar, entityId: scalar, requiredLevel: scalar, availableAfterRewardLevel: scalar }] },
 requirement,
 clothing_set: { ...identity, unlock, setBonus: stats },
 clothing_item: { ...identity, setId: scalar, categoryId: scalar, baseBonus: stats, price, unlock, supportsMutagen: scalar },
 weapon: { ...identity, weaponId: scalar, requiredLevel: scalar, maxLevel: scalar, baseBonus: stats, bonuses: stats, price, unlock, durabilityMax: scalar },
 pet: { ...identity, petId: scalar, requiredLevel: scalar, maxLevel: scalar, baseBonus: stats, bonuses: stats, price, unlock },
 room: { ...identity, bonuses: stats, price, unlock },
 ornament_zone: { ...identity, zoneId: scalar, zoneNumber: scalar },
 ornament_set: { ...identity, setId: scalar, setBonus: stats, unlock },
 ornament_element: { ...identity, elementId: scalar, setId: scalar, zoneId: scalar, zoneNumber: scalar, baseBonus: stats, bonuses: stats, price, unlock },
 stash_set: { ...identity, setId: scalar, rewards, kind: scalar, requiredSets: [scalar], medallionReward: { ...identity, bonuses: stats } },
 stash_ingredient: { ...identity, ingredientId: scalar, setId: scalar, purchasePrice: price },
 achievement_category: { ...identity, category: scalar },
 achievement: { ...identity, achievementKey: scalar, category: scalar, threshold: scalar, points: scalar, reward: rewards },
 quest: { ...identity, questId: scalar, taskId: scalar, section: scalar, type: scalar, target: scalar, targetCount: scalar, required: scalar, reward: rewards, rewards },
 mutagen_type: { type: scalar, name: scalar },
 mutagen: { ...identity, mutagenId: scalar, type: scalar, level: scalar, rank: scalar, bonuses: stats, installPillCost: scalar, extractionPillCost: scalar },
 mutagen_recipe: { ...identity, recipeId: scalar, type: scalar, inputLevel: scalar, outputLevel: scalar, resultMutagenId: scalar, requiredAmount: scalar, costPills: scalar, price },
 mutagen_exchange_recipe: { ...identity, recipeId: scalar, type: scalar, inputLevel: scalar, outputLevel: scalar, requiredAmount: scalar, costPills: scalar, price },
 bank_package: { ...identity, stars: scalar, amount: scalar, currency: scalar },
 customization: { defaultFaceId: scalar, defaultHairstyleId: scalar, defaultHairColorId: scalar, faceCount: scalar, hairstyleCount: scalar, hairColorCount: scalar, faceIds: [scalar], hairstyleIds: [scalar], hairColorIds: [scalar] },
};
export function project(value, rule) {
  if (value === null) return null;
  if (rule === true) return ['string','number','boolean'].includes(typeof value) ? value : undefined;
  if (Array.isArray(rule)) return Array.isArray(value) ? value.map(v => project(v,rule[0])).filter(v => v !== undefined) : undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result = {};
  for (const [key, child] of Object.entries(rule)) {
    if (!Object.hasOwn(value,key)) continue;
    const selected = project(value[key],child);
    if (selected !== undefined) result[key] = selected;
  }
  return result;
}
export function referenceRecord(kind,value) { return project(value,projections[kind]); }
export function catalogueRoute(url) {
  const parsed = new URL(url,'http://127.0.0.1');
  const path = parsed.pathname;
  const exact = ['/api/floors','/api/clothing','/api/rooms','/api/stash/sets','/api/bank/packages','/api/player/customization/options','/api/achievements','/api/mutagens/state','/api/mutagens/exchange/state'];
  const patterns = [/^\/api\/floors\/[^/]+\/info$/, /^\/api\/bosses\/\d+$/, /^\/api\/businesses\/\d+$/, /^\/api\/clothing\/(by-category|sets)\/\d+$/, /^\/api\/weapons\/\d+$/, /^\/api\/pets\/\d+$/, /^\/api\/ornaments\/(zones|sets)\/\d+(\/zones)?$/, /^\/api\/achievements\/[a-z]+$/, /^\/api\/quests\/\d+$/];
  if (!exact.includes(path) && !patterns.some(p=>p.test(path))) return null;
  const query = new URLSearchParams();
  for (const key of ['type','level']) if (parsed.searchParams.has(key)) query.set(key,parsed.searchParams.get(key));
  return path + (query.size ? '?'+query : '');
}
