# Norteño Voice Trainer

Aplicación web estática para entrenar segunda voz estilo norteño.

## Nombre sugerido del repositorio

`norteno-voice-trainer`

## Funciones incluidas

- Grabación de melodía principal cantando o tarareando.
- Detección básica de pitch desde el micrófono del navegador.
- Procesamiento de melodía: agrupación de notas y eliminación de fragmentos muy cortos.
- Regla fija de segunda voz norteña en modo agudo o grave.
- Ejemplo: `D4` en modo grave produce `A#3`.
- Línea de tiempo editable.
- Reproducción de primera voz y segunda voz generada.
- Práctica con micrófono y medidor visual de afinación.
- Guardado local en el navegador.
- Importación/exportación de canciones en JSON.
- Compatible con GitHub Pages.

## Regla de voces

| Primera voz | Aguda | Grave |
|---|---|---|
| DO | MI | SOL# |
| RE | FA# | LA# |
| MI | SOL# | DO |
| FA | LA | DO# |
| SOL | SI | RE# |
| LA | DO# | FA |
| SI | RE# | SOL |

## Uso local

Abre `index.html` en un navegador moderno.

Para que el micrófono funcione de forma confiable, se recomienda servir la carpeta con un servidor local:

```bash
python3 -m http.server 8000
```

Luego abre:

```text
http://localhost:8000
```

## Publicar en GitHub Pages

1. Crea un repositorio llamado `norteno-voice-trainer`.
2. Sube estos archivos a la rama `main`.
3. En GitHub ve a `Settings > Pages`.
4. En `Build and deployment`, selecciona:
   - Source: `Deploy from a branch`
   - Branch: `main`
   - Folder: `/root`
5. Guarda los cambios.

La app quedará publicada como:

```text
https://TU-USUARIO.github.io/norteno-voice-trainer/
```

## Nota técnica

La detección de pitch usa autocorrelación simple. Es suficiente para una primera versión funcional, pero puede mejorarse después con una librería especializada como Pitchy o YIN.

## Corrección 2026-06-03

- La grabación ahora acumula segmentos sostenidos por duración real, incluso si hay pequeños huecos de detección.
- La reproducción sintetizada usa una envolvente suave para evitar golpes/clics y sostener la nota durante su duración.


## Corrección visual y de audio (2026-06-03, actualización posterior)

- La referencia reproducida ahora usa un sintetizador más claro y estable para que sirva mejor como guía vocal.
- Se añadió una línea de tiempo visual tipo gráfico: amarillo = segunda voz, azul = melodía principal, blanco = tu voz.
- Durante la práctica aparece un cursor vertical para seguir mejor el avance de la frase.
