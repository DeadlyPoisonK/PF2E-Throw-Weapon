# PF2E - Throw Weapon

Módulo para **Foundry VTT v14** y el sistema **Pathfinder 2e** que automatiza qué pasa con un arma cuando se **lanza**.

Cuando un personaje hace un Strike lanzado (dardo, daga arrojada, hacha de mano, etc.):

- **Se resta del inventario** del lanzador (1 unidad del montón; si era la última, el ítem se borra).
- **Si acierta** (éxito o crítico) con un objetivo marcado: el arma **pasa al inventario del objetivo**.
- **Si falla**: el arma **queda en el piso** como un *Item Pile*, en una de las 4 casillas contiguas al objetivo (de preferencia una libre y sin muro de por medio). Si ya hay una pila en esas casillas, el arma se suma a esa pila en vez de crear otra.
- **Sin objetivo o sin resultado**: pregunta qué pasó (cae al piso junto al lanzador, se pierde, o no hacer nada).
- **El arma sale de la mano**: si el montón estaba en la mano (`held`), pasa a `worn` aunque queden unidades.
- Espera a que termine la animación de **Dice So Nice** (si está activo) antes de mover nada o avisar, para no adelantar el resultado.
- El aviso es un mensaje arriba (lanzador y GMs), sin tarjetas extra en el chat. Se puede cambiar en los ajustes.

## Requisitos

- Foundry VTT 14
- Sistema PF2e 8.6.1 o superior
- [Item Piles](https://foundryvtt.com/packages/item-piles) 3.3.1 o superior
- [Item Piles: PF2e](https://foundryvtt.com/packages/itempiles-pf2e)

Si falta alguno de los dos módulos de Item Piles, Throw Weapon **no toca el inventario** y muestra un aviso indicando cuál activar.

## Instalación

En Foundry: *Add-on Modules → Install Module → Manifest URL*:

```
https://github.com/DeadlyPoisonK/PF2E-Throw-Weapon/releases/latest/download/module.json
```

## Ajustes (mundo)

| Ajuste | Qué hace |
|---|---|
| Al acertar, el arma pasa al objetivo | Si se desactiva, un arma que acierta se pierde. |
| Al fallar, el arma queda en el piso | Si se desactiva, un arma que falla se pierde. |
| Desequipar el montón al lanzar | El montón pasa de la mano a `worn` al lanzar. |
| Aviso del resultado | Mensaje arriba (por defecto), tarjeta solo para GM, tarjeta pública o nada. |

## Excepciones

- Runa `returning` o rasgo `tethered`: el arma vuelve a la mano; no se toca nada.
- Rasgo `recovery`: si falla vuelve a la mano; si acierta va al objetivo.
- Un ítem con el flag `flags.pf2e-throw-weapon.mode` en `ignore` se salta; en `consume` solo se resta 1 sin mover nada.

## Notas

- Para el resultado automático hay que **marcar un objetivo** (target) antes de atacar.
- Todo lo que requiere permisos de GM (mover ítems entre actores, crear tokens) lo hace la API de Item Piles por su socket; el módulo no necesita un socket propio para eso. El único socket propio es el aviso a los GMs.
- Los jugadores que no son quien lanza ni GM no ven el aviso.

## Compatibilidad

Verificado en Foundry 14.369 con PF2e 8.7.0.

## Licencia

MIT
