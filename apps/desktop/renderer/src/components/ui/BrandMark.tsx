// 两处品牌入口共用现有单图标，保持原图比例和无障碍名称。
export function BrandMark({ className = '' }: { className?: string }) {
  return <img className={`umi-brandmark ${className}`.trim()} src="/umi-logo.png"
    alt="Umi" width={512} height={512} draggable={false} />;
}
