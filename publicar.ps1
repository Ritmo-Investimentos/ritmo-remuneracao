# Script para publicar o sistema no Firebase Hosting gratuitamente
$ErrorActionPreference = "Stop"

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  Publicando no Firebase Hosting (Web)   " -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

$exePath = Join-Path $PSScriptRoot "firebase.exe"

# 1. Baixa a ferramenta do Firebase se ainda não existir
if (-not (Test-Path $exePath)) {
    Write-Host "[1/3] Baixando a ferramenta do Firebase (aguarde alguns instantes)..." -ForegroundColor Yellow
    $url = "https://firebase.tools/bin/win/instant/latest"
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $url -OutFile $exePath -UseBasicParsing
    Write-Host "-> Download concluído!" -ForegroundColor Green
} else {
    Write-Host "[1/3] Ferramenta do Firebase pronta." -ForegroundColor Green
}

Write-Host ""
Write-Host "[2/3] Autenticando com sua conta Google..." -ForegroundColor Yellow
Write-Host "Uma janela do navegador vai abrir para você autorizar o Firebase." -ForegroundColor Gray
& $exePath login --no-localhost

Write-Host ""
Write-Host "[3/3] Enviando arquivos para a Web..." -ForegroundColor Yellow
& $exePath deploy --only hosting

Write-Host ""
Write-Host "==========================================" -ForegroundColor Green
Write-Host "  SUCESSO! O sistema agora está online!   " -ForegroundColor Green
Write-Host "  Acesse em: https://remuneracao-ritmo.web.app" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Green
Write-Host ""
Pause
