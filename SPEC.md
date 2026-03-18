# Model Selection UI

Add support for letting users select specific weather models. It should default to showing all available models with Magic Blend (the current blended implementation), but also allow users to override which forecast sources are used. Users can deselect certain models. They can also separately turn Magic Blend on or off. When Magic Blend is off a default blend should be used (naive to the weights calculated from the statistics parquet included in the blend grid json). This will help users interpret the forecasts better by exploring the contributions from different models.
