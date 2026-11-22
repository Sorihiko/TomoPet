# 把一张 PNG 缩成几个正方形尺寸（给 exe 图标用），用 Windows 自带的 System.Drawing，不用另外装东西。
#   powershell -NoProfile -File resize-png.ps1 -Source logo.png -OutDir <文件夹> -Sizes 16,24,32,48,64,128,256
# 输出 <OutDir>\<尺寸>.png（透明背景，高质量双三次缩放，不是正方形的原图按长边缩放后居中）。
param(
  [Parameter(Mandatory = $true)][string]$Source,
  [Parameter(Mandatory = $true)][string]$OutDir,
  # 用 -File 调用时逗号不会被拆成数组：按字符串收，自己拆。
  [string]$Sizes = '16,24,32,48,64,128,256'
)
$ErrorActionPreference = 'Stop'
# 输出（包括报错）按 UTF-8：不然中文报错按 GBK 出去，Node 那边读成乱码。
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$sizeList = @($Sizes -split '[,\s]+' | Where-Object { $_ } | ForEach-Object { [int]$_ })
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile((Resolve-Path -LiteralPath $Source).Path)
try {
  New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
  foreach ($size in $sizeList) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
      $g.Clear([System.Drawing.Color]::Transparent)
      $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
      $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
      $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $scale = [Math]::Min($size / $src.Width, $size / $src.Height)
      $w = [int][Math]::Round($src.Width * $scale)
      $h = [int][Math]::Round($src.Height * $scale)
      $attrs = New-Object System.Drawing.Imaging.ImageAttributes
      $attrs.SetWrapMode([System.Drawing.Drawing2D.WrapMode]::TileFlipXY)
      $rect = New-Object System.Drawing.Rectangle([int](($size - $w) / 2), [int](($size - $h) / 2), $w, $h)
      $g.DrawImage($src, $rect, 0, 0, $src.Width, $src.Height, [System.Drawing.GraphicsUnit]::Pixel, $attrs)
    } finally { $g.Dispose() }
    $bmp.Save((Join-Path $OutDir "$size.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
  }
} finally { $src.Dispose() }
Write-Output "ok"
