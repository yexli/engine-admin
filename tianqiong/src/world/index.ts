/* GameCore 公共出口（表现层只应从这里进入引擎） */
export { world } from './WorldAPI';
export type { WorldTimeView, NpcEntry } from './WorldAPI';
export type { WorldEvent } from '@/events/EventSchema';
export { bus, scheduler, rng, esc, rich } from '@/events/EventBus';
export { core, newState, flushSave, save } from '@/world/WorldState';
export { newGame, continueSave, importState, resetWorld, dispatch } from '@/world/WorldRuntime';
export { sceneTime, timeStr, shichenOf, seasonName, periodSeg, timeOfDayOf } from '@/world/WorldClock';
export type { TimeOfDay } from '@/world/WorldClock';
export { stat, mod, maxHp, maxMp, raceName, clsName, rankName, rankTierName, rankSub, rankAliases, rankFull, mainStat, AC, atkB, xpNeed } from '@/systems/character/Derived';
export { presentNPCs, npcAt, npcCurLoc, npcSeg, npcActNow, attOf, attWord, attColor, npcDyn, passerby } from '@/systems/npc/Npcs';
export type { Passerby } from '@/systems/npc/Npcs';
export { relOf, relsOf, adjRel, spreadRumor } from '@/systems/relationship/Relations';
export { repAxis, adjRepAxis, relBetween, standingBetween, adjFactionRel, relWord, playerStanding, factionName } from '@/systems/faction/Factions';
export {
  tradeBuyMod,
  tradeSellMod,
  templeServiceOk,
  templeFee,
  guardChance,
  infoReveal,
  trustOk,
  militaryLeniency,
  militaryTier,
  intelTier,
  militaryCallable,
  gateTaxFree,
  privateArmy,
  intelForesight,
  intelDoubt,
  intelNetwork,
  addMilitary,
  addIntelGather,
  addIntelObserve,
  addIntelDeep,
  settleAxes,
  grantPrivileges,
  foresightTitles,
  doubtMark,
  isMilitiaFoe,
  loreFacts,
  MIL_TIERS,
  INTEL_TIERS,
  MIL_DAY_CAP,
  INTEL_GATHER_CAP,
  INTEL_OBSERVE_CAP,
} from '@/systems/faction/Diplomacy';
export type { SettleResult } from '@/systems/faction/Diplomacy';
export { ALL_EVENTS, eventMeta, eventAftermath } from '@/events/EventProcessor';
export { crimeName, crimeGrade, gradeLabel, penaltyLabel, isLawless } from '@/systems/law/Law';
export { priceOf, vendorCoin, vendorPays, vendorEarns, econRevert, initVendors } from '@/systems/economy/Economy';
export { allRoutes, routeById, routeTo, canDepart, depart } from '@/systems/travel/Travel';
export { canEnter, continentOf, continentUnlocked, continentLockReason } from '@/systems/travel/Travel';
/* 卡 S2：交通体系（世界书 §81/§83/§85） */
export {
  travelModes,
  portalTiers,
  cityTransit,
  portalLimits,
  portalCost,
  portalBannedItem,
  portalCarryBan,
  canTeleport,
  cityTransitCost,
  daysByMode,
} from '@/systems/travel/Travel';
/* 卡 S1：地标与六星险区（世界书 §73/§75） */
export {
  landmarks,
  landmarksOf,
  landmarksHere,
  dangerZones,
  zonesOf,
  zoneById,
  zoneEncounterChance,
  enterZone,
} from '@/systems/travel/Travel';
/* 卡 E2：城内可达性三件套。地图给路径、玩家一段段走——加自动多跳会吞掉
   每跳的夜间遇袭与城卫盘查结算，所以这里只有查询，没有「一次走完」。 */
export { neighborsOf, isDirect, routeBetween, reach } from '@/systems/travel/Travel';
export type { Reach } from '@/systems/travel/Travel';
export { hasIllegalStr, itemCount, addRep, gainExp, gainGold, addItem, removeItem } from '@/systems/character/Gains';
export {
  rollInstance,
  rollQuality,
  qualityWeights,
  affixById,
  affixCount,
  affixScale,
  affixPoolOf,
  qualityName,
  qualityColor,
  qualityMult,
  instName,
  instAffixText,
  instProperName,
  instMods,
  instPrice,
  wornMods,
  critRate,
  addInstance,
  removeInstance,

  isInstance,
  nextUid,
  AFFIX_CAP,
  CRIT_BASE,
  CRIT_MAX,
} from '@/systems/inventory/Equip';
export type { AffixDef, InstMods } from '@/systems/inventory/Equip';
export { bondOf, grudgeOf, intimacyUpOk } from '@/systems/relationship/Bond';
export type { BondView } from '@/systems/relationship/Bond';
export { chatTier, chatChips } from '@/systems/npc/Chat';
export { questLabel, canTurnIn } from '@/systems/quest/Quests';
export { shopRows, sellRows, openShop } from '@/systems/economy/Shop';
export { leakLevel, leakName, leakDesc, isOpen as abyssOpen, ensureAbyss } from '@/systems/dungeon/Abyss';
export {
  floorOf,
  themeOf,
  trapOf,
  entryAt,
  allEntries,
  lootOf,
  ensureDungeon,
  entryUnlocked,
  entryLockReason,
  enterDungeon,
  nextFloor,
  retreat as dungeonRetreat,
  dungeonTick,
  dungeonMenu,
  entryMenu,
  dungeonView,
  trialMirror,
  inDungeon,
  npcOnFloor,
  MAX_FLOOR as DUNGEON_MAX_FLOOR,
} from '@/systems/dungeon/Dungeon';
export * as combat from '@/systems/combat/Combat';
export {
  THEOSELECT,
  theoselectView,
  theoselectMenu,
  theoselectTick,
  stageAdvance,
  stageNames,
  enroll as theoselectEnroll,
  enrollBlock as theoselectEnrollBlock,
  evaluate as theoselectScore,
  standings as theoselectStandings,
  playerRank as theoselectRank,
  rewardFor as theoselectReward,
  spectate as theoselectSpectate,
  templeOf,
  templeFavor,
  rivalName,
  setAscendHook,
  ensureTheoselect,
} from '@/systems/religion/Theoselect';
export type { TheoselectView } from '@/systems/religion/Theoselect';
export {
  ensureAcademy,
  academyView,
  academyMenu,
  academyCoursesMenu,
  enroll as academyEnroll,
  enrollCheck as academyEnrollCheck,
  study as academyStudy,
  graduate as academyGraduate,
  degreeOf,
  canGraduate,
  tuitionDue,
  mentorOf,
  allMentors,
  pathOfFocus,
  templeSchoolsOf,
} from '@/systems/academy/Academy';
export type { AcademyView, AcademyCourseView, AcademyCatalogRow, MentorView } from '@/systems/academy/Academy';
export {
  DEITY_IDS,
  isDeityId,
  deityName,
  deityTitle,
  deityTemple,
  deityDomains,
  faithClassesOf,
  ensureFavor,
  favorOf,
  deityRank,
  pray,
  divineIntervene,
  ascendCandidate,
  deityDetail,
  deityMenu,
  deityView,
  divineRanks,
  favorDayState,
} from '@/systems/religion/Deity';
export type { DeityView, DeityRow } from '@/systems/religion/Deity';
export { generateName, validateName, batchGenerate, nameFromLore, namingRaces, resolveRace, isBlocked } from '@/systems/naming/Naming';
/* 卡 G1：命名六维（地区/组织/装备/魔物/地下城层/技能遗迹） */
/* 卡 G1：命名六维（地区/组织/装备/魔物/地下城层/技能遗迹） */
export {
  generatePlace,
  generateOrg,
  generateItem,
  generateMonster,
  generateFloor,
  generateSkillOrRelic,
  generateDimension,
  namingDimensions,
} from '@/systems/naming/Naming';
export {
  craftStations,
  craftRecipes,
  isIllegalRecipe,
  stationOf,
  stationAt,
  stationOfNpc,
  stationGate,
  stationName,
  craftLv,
  canCraft,
  successRate,
  craftView,
  craftMenu,
  craftHere,
  craft,
} from '@/systems/inventory/Craft';
export type { CraftRow, CraftView } from '@/systems/inventory/Craft';
export {
  CODEX_CATS,
  OBS_CAP,
  allLore,
  loreById,
  catOf,
  codexUnlocked,
  codexStats,
  codexView,
  codexMenu,
  matchByText,
  observeUnlock,
  deepTalkUnlock,
  readTome,
  tryUnlock,
  tomeWeight,
} from '@/systems/codex/Codex';
export type { CodexRow, CodexView, CodexStat } from '@/systems/codex/Codex';
export {
  titleDefs,
  titleById,
  suppressCost,
  condMet,
  evalTitles,
  titlesOf,
  visibleTitles,
  primaryTitle,
  titleScore,
  suppressTitle,
  fameDiscount,
  marshalGuardMul,
  titleWord,
  titleView,
} from '@/systems/reputation/Title';
export type { TitleDef, TitleRow, TitleView, TitleCond } from '@/systems/reputation/Title';
export { freeAct } from '@/actions/ActionParser';
export { setAiPort, setSavePort, ai, savePort } from '@/plugins/PluginInterface';
export type { AiPort, AiHelpers, SavePort } from '@/plugins/PluginInterface';
export type { GameCommand, SheetDesc, CheckDesc, ToastDesc, CoreEvent, OptDesc, DialogSheet, ConfirmSheet, ShopSheet, CombatItemSheet } from '@/types/uispec';
export type { WorldState, CombatState, CombatFoe } from '@/types/world';
