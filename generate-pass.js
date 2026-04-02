require('dotenv').config()
const { PKPass } = require('passkit-generator')
const path = require('path')
const fs = require('fs')

async function generatePass() {
  const pass = await PKPass.from({
    model: path.resolve(__dirname, 'pass-model.pass'),
    certificates: {
      wwdr: fs.readFileSync(path.resolve(__dirname, 'WWDR-pem.pem')),
      signerCert: fs.readFileSync(path.resolve(__dirname, 'signer-clean.pem')),
      signerKey: fs.readFileSync(path.resolve(__dirname, 'nuvy-pass.key'))
    }
  }, {
    serialNumber: 'NUVY-TEST-001'
  })

  const buffer = pass.getAsBuffer()
  fs.writeFileSync(path.resolve(__dirname, 'test.pkpass'), buffer)
  logger.info('Carte générée : test.pkpass')
}

generatePass().catch(console.error)
