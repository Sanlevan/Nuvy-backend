require('dotenv').config()
const express = require('express')
const { createClient } = require('@supabase/supabase-js')

const app = express()
app.use(express.json())

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
)

// Récupérer toutes les boutiques
app.get('/boutiques', async (req, res) => {
  const { data, error } = await supabase
    .from('boutiques')
    .select('*')
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// Créer une boutique
app.post('/boutiques', async (req, res) => {
  const { nom, couleur } = req.body
  const { data, error } = await supabase
    .from('boutiques')
    .insert([{ nom, couleur }])
    .select()
  if (error) return res.status(500).json({ error: error.message })
  res.json(data[0])
})

// Enrôler un client dans une boutique
app.post('/boutiques/:boutique_id/clients', async (req, res) => {
  const { boutique_id } = req.params
  const { nom } = req.body
  const { data, error } = await supabase
    .from('clients')
    .insert([{ boutique_id, nom }])
    .select()
  if (error) return res.status(500).json({ error: error.message })
  res.json(data[0])
})

// Ajouter un tampon à un client
app.post('/clients/:client_id/tampon', async (req, res) => {
  const { client_id } = req.params

  const { data: client, error: fetchError } = await supabase
    .from('clients')
    .select('*')
    .eq('id', client_id)
    .single()

  if (fetchError) return res.status(500).json({ error: fetchError.message })

  const nouveaux_tampons = client.tampons + 1

  const { data, error } = await supabase
    .from('clients')
    .update({ tampons: nouveaux_tampons })
    .eq('id', client_id)
    .select()

  if (error) return res.status(500).json({ error: error.message })
  res.json(data[0])
})

// Récupérer les clients d'une boutique
app.get('/boutiques/:boutique_id/clients', async (req, res) => {
  const { boutique_id } = req.params
  const { data, error } = await supabase
    .from('clients')
    .select('*')
    .eq('boutique_id', boutique_id)
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})
// Vérifier si un client a atteint sa récompense
app.get('/clients/:client_id/recompense', async (req, res) => {
  const { client_id } = req.params

  const { data: client, error: fetchError } = await supabase
    .from('clients')
    .select('*, boutiques(tampons_requis)')
    .eq('id', client_id)
    .single()

  if (fetchError) return res.status(500).json({ error: fetchError.message })

  const a_gagne = client.tampons >= client.boutiques.tampons_requis

  if (a_gagne) {
    // Remet le compteur à zéro
    await supabase
      .from('clients')
      .update({ tampons: 0 })
      .eq('id', client_id)

    return res.json({
      recompense: true,
      message: `Félicitations ${client.nom} ! Vous avez gagné votre récompense.`,
      tampons: 0
    })
  }

  res.json({
    recompense: false,
    message: `${client.tampons} tampons sur ${client.boutiques.tampons_requis}`,
    tampons: client.tampons
  })
})
app.listen(3000, () => {
  console.log('Serveur Nuvy démarré sur le port 3000')
})