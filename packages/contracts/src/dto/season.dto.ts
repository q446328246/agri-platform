/** 作物季简要信息 */
export interface CropSeasonBrief {
  seasonId: string;
  seasonCode: string;
  parcelId: string;
  /** 作物品种编码，关联作物字典 */
  cropCode: string;
  /** 播种或定植日期，格式 YYYY-MM-DD */
  sowDate: string;
  /** 当前生育期名称 */
  growthStage: string;
  /** 状态，取值来自 SeasonStatus */
  status: number;
}
